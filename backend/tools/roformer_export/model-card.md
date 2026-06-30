---
license: mit
library_name: onnxruntime
pipeline_tag: audio-to-audio
tags:
  - onnx
  - onnxruntime
  - audio
  - music
  - source-separation
  - stem-separation
  - bs-roformer
  - roformer
  - drums
  - bass
  - musdb18-hq
---

# Silverdaw Rhythm Quality Pack — 4-stem BS-RoFormer (ONNX)

A host-STFT ONNX export of a 4-stem **BS-RoFormer** music source-separation model
(bass / drums / other / vocals), used by [Silverdaw](https://github.com/irarainey/silverdaw)
as its optional higher-quality **drums + bass** model. Silverdaw runs the model
once and keeps the **drums** and **bass** outputs (vocals come from a dedicated
vocal model; `other` is reconstructed as the residual).

The `torch.stft` / `torch.istft` are stripped out of the graph: the ONNX core
consumes a precomputed STFT and returns the masked per-stem spectrogram, and the
host application runs the STFT and per-stem iSTFT. This keeps the graph portable
(standard ONNX ops, opset 17, no contrib operators) so it runs on the CPU and on
DirectX 12 GPUs via ONNX Runtime's DirectML execution provider.

## Files

| File | Size | Notes |
| --- | --- | --- |
| `bs_roformer_4stem_rhythm_fp16.onnx` | ~257 MB | fp16 weights, single self-contained graph (no external `.onnx.data`). |

## I/O contract

- **Inputs** — `spec_real`, `spec_imag`, each `float32 [1, 2, 1025, 801]` =
  (batch, audio channel, frequency bin, time frame): the real and imaginary parts
  of `torch.stft(audio, n_fft=2048, hop_length=441, win_length=2048,
  window=hann, center=True, normalized=False)`.
- **Outputs** — `out_spec_real`, `out_spec_imag`, each
  `float32 [1, 4, 2, 1025, 801]` = (batch, stem, channel, freq, frame): the masked
  spectrogram per stem. **Stem order: `drums, bass, other, vocals`.** The DC bin
  is zeroed in-graph.
- **Window** — traced at a fixed 8 s chunk (`T = 801` frames, 352,800 samples at
  44.1 kHz). The rotary embedding caches by sequence length, so the time axis is
  fixed; callers chunk the audio and overlap-add. Reconstruct each stem with the
  inverse STFT (same parameters) and a windowed overlap-add normalised by an
  accumulated window counter.

## Provenance & license

**License: MIT.** This export combines three MIT-licensed sources:

- **Weights** — © ZFTurbo, from
  [`ZFTurbo/Music-Source-Separation-Training`](https://github.com/ZFTurbo/Music-Source-Separation-Training)
  (the `model_bs_roformer_ep_17_sdr_9.6568` 4-stem checkpoint, config
  `config_bs_roformer_384_8_2_485100`, trained on MUSDB18-HQ; release v1.0.12).
- **Architecture** — *BS-RoFormer* /
  [`lucidrains/BS-RoFormer`](https://github.com/lucidrains/BS-RoFormer) (MIT).
- **Export pipeline** — the host-STFT ONNX wrapper is derived from the MIT
  [`elicwhite/bs-roformer-web`](https://github.com/elicwhite/bs-roformer-web)
  build pipeline.

**Note on training data:** the model was trained on MUSDB18-HQ, whose dataset
terms are research-oriented. Whether dataset terms reach through to the resulting
weights is an unsettled, industry-wide question; this export treats the trained
weights as governed by the trainer's chosen MIT license, the same posture taken
by other openly-distributed separation models (e.g. htdemucs).

## Intended use

Designed for offline (non-real-time) stem separation inside a desktop DAW. It is
not a real-time audio-callback model — run it on a worker/background thread.
