# `roformer_export` — Rhythm Quality Pack export recipe

The reproducible pipeline that produces Silverdaw's **Rhythm Quality Pack** —
the 4-stem BS-RoFormer ONNX (`drums`, `bass`, `other`, `vocals`) published at
[`silverdaw/bs-roformer-rhythm-onnx`](https://huggingface.co/silverdaw/bs-roformer-rhythm-onnx)
and consumed by the backend's `BsRoformerRhythm` runner.

This is an **offline build tool**, not part of the backend build. It is plain
Python (no CMake wiring) and is run by hand when the model needs to be
re-exported. The large inputs/outputs it consumes and produces (checkpoint,
ONNX, reference tensors, audio) are intentionally **not** committed — only the
recipe lives here.

## What it does

ZFTurbo's BS-RoFormer bakes `torch.stft` / `torch.istft` into `forward()`. For a
portable, contrib-op-free graph that runs on CPU and on DirectX 12 GPUs via the
DirectML execution provider, those transforms are stripped out: the exported
ONNX consumes a precomputed STFT (`spec_real`, `spec_imag`) and returns the
masked per-stem spectrogram, and the **host** (the C++ runner) does the STFT and
per-stem iSTFT. The model is traced at a fixed 8 s window (`T = 801`) because the
rotary embedding caches by sequence length, so the time axis cannot flex.

See `model-card.md` for the exact I/O contract, tensor shapes, and stem order —
it is the card published alongside the model on Hugging Face.

## Layout

| Path | Purpose |
| --- | --- |
| `export_4stem.py` | Trace the checkpoint to a host-STFT fp32 ONNX and save `reference_t<T>.npz` for parity. |
| `python/wrapper.py` | The host-STFT `nn.Module` wrapper (STFT/iSTFT removed; complex multiply unrolled for ONNX). Shared by the exporter. |
| `python/fp16_weights.py` | Fold Conv/MatMul/Gemm weight initializers to fp16 + `Cast(fp16→fp32)`, halving file size with no CPU precision loss. Produces the shipped `*_fp16.onnx`. |
| `python/validate_onnx.py` | Assert ONNX-Runtime (CPU) output matches the PyTorch reference (max abs diff < 1e-3). |
| `full_track_4stem.py` | End-to-end full-track separation + sum-null check; writes per-stem WAVs for auditioning. |
| `python/compare_stems.py` | Generic QA: correlation / RMS-diff / SI-SDR between two stem renders. |
| `config_bs_roformer.yaml` | The 4-stem model config (geometry, band split, instruments). |
| `model-card.md` | The Hugging Face model card for the published pack. |

## Prerequisites

1. **MSST checkout** — clone
   [`ZFTurbo/Music-Source-Separation-Training`](https://github.com/ZFTurbo/Music-Source-Separation-Training)
   (release v1.0.12) for the `BSRoformer` class. Either place it as
   `./Music-Source-Separation-Training` beside these scripts, or point the
   `MSST_ROOT` environment variable at your checkout (`wrapper.py` reads it).
2. **Checkpoint** — download the 4-stem `model_bs_roformer_ep_17_sdr_9.6568`
   checkpoint (config `config_bs_roformer_384_8_2_485100`, MUSDB18-HQ) from the
   ZFTurbo release and save it next to `export_4stem.py` as
   `model_bs_roformer_4stem.ckpt`.
3. **Python deps** — `torch`, `onnx`, `onnxruntime`, `numpy`, `pyyaml`,
   `einops`, `soundfile` (plus `librosa` for `compare_stems.py`).

## Pipeline

```bash
# 1. Trace -> artifacts/bs_roformer_4stem_t801_fp32.onnx + reference_t801.npz
#    (the optional arg is chunk length in samples; default 485100 = 11 s.
#     Silverdaw ships the 8 s / 352800-sample window: T = 801.)
python export_4stem.py 352800

# 2. Fold weights to fp16 -> the shipped, self-contained graph
python python/fp16_weights.py \
  --in-path  artifacts/bs_roformer_4stem_t801_fp32.onnx \
  --out-path artifacts/bs_roformer_4stem_rhythm_fp16.onnx

# 3. Verify the export is faithful (CPU EP, fp32-clean)
python python/validate_onnx.py \
  --onnx artifacts/bs_roformer_4stem_rhythm_fp16.onnx \
  --reference artifacts/reference_t801.npz

# 4. (Optional) audition a full track + sum-null sanity check
python full_track_4stem.py artifacts/bs_roformer_4stem_rhythm_fp16.onnx 352800
```

The fp16 file from step 2 is what gets uploaded to Hugging Face (with
`model-card.md`). The frontend manifest
(`frontend/src/main/stems/bsRoformerRhythmModel.ts`) pins its size + SHA-256, so
re-exports must be re-pinned there.

## Provenance & license

**License: MIT**, consistent with every input:

- **Weights** — © ZFTurbo
  ([`Music-Source-Separation-Training`](https://github.com/ZFTurbo/Music-Source-Separation-Training),
  MUSDB18-HQ 4-stem checkpoint, v1.0.12).
- **Architecture** — *BS-RoFormer* /
  [`lucidrains/BS-RoFormer`](https://github.com/lucidrains/BS-RoFormer).
- **Host-STFT export approach** — derived from the MIT
  [`elicwhite/bs-roformer-web`](https://github.com/elicwhite/bs-roformer-web)
  build pipeline.

Training-data provenance is an unsettled, industry-wide question; this export
treats the trained weights as governed by the trainer's chosen MIT licence — the
same posture taken by other openly-distributed separation models. See
`THIRD_PARTY_LICENSES.md` at the repository root.
