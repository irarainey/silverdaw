"""Export ZFTurbo's clean MIT 4-stem BS-Roformer to a host-STFT ONNX.

Uses elicwhite's MIT wrapper (STFT/iSTFT stripped out of the graph) but with
THIS model's geometry: hop_length=441, n_fft=2048, win=2048, native chunk
dim_t=1101 (485100 samples / 11 s) — matching ZFTurbo's reference inference so
the benchmarked SDR holds. Stems: [drums, bass, other, vocals].

Output graph: (spec_real[1,2,1025,1101], spec_imag) -> (out_spec_real
[1,4,2,1025,1101], out_spec_imag). Saves reference.npz for parity validation
on Silverdaw's real ORT via SilverdawSpecOnnxProbe.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "python"))
from wrapper import (  # noqa: E402
    BSRoformerONNXWrapper,
    build_model_from_yaml,
    compute_stft_for_input,
    istft_from_spec,
)

CKPT = HERE / "model_bs_roformer_4stem.ckpt"
YAML = HERE / "config_bs_roformer.yaml"

N_FFT = 2048
HOP = 441
WIN = 2048
SAMPLES = int(sys.argv[1]) if len(sys.argv) > 1 else 485100   # dim_t = 1101 at hop 441
OPSET = 17
_T = SAMPLES // HOP + 1
OUT = HERE / "artifacts" / f"bs_roformer_4stem_t{_T}_fp32.onnx"
REF = HERE / "artifacts" / f"reference_t{_T}.npz"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(YAML) as f:
        cfg = yaml.unsafe_load(f)
    stems = list(cfg["training"]["instruments"])  # ['drums','bass','other','vocals']
    print("stems:", stems)

    print(f"Loading {CKPT.name}")
    model = build_model_from_yaml(YAML, CKPT)
    wrapper = BSRoformerONNXWrapper(model).eval()
    assert wrapper.num_stems == len(stems), (wrapper.num_stems, len(stems))

    torch.manual_seed(0)
    audio = torch.randn(1, 2, SAMPLES) * 0.01
    spec_r, spec_i = compute_stft_for_input(audio, n_fft=N_FFT, hop_length=HOP, win_length=WIN)
    print(f"Tracing at spec shape {tuple(spec_r.shape)} (hop={HOP})")

    for folding in (True, False):
        try:
            t0 = time.time()
            torch.onnx.export(
                wrapper, (spec_r, spec_i), str(OUT),
                input_names=["spec_real", "spec_imag"],
                output_names=["out_spec_real", "out_spec_imag"],
                dynamic_axes=None, opset_version=OPSET,
                do_constant_folding=folding, dynamo=False,
            )
            print(f"  exported (folding={folding}) in {time.time()-t0:.1f}s "
                  f"({OUT.stat().st_size/1024/1024:.1f} MB)")
            break
        except (RuntimeError, MemoryError) as e:
            print(f"  export with folding={folding} failed: {e}")
            if not folding:
                raise

    import onnx
    m = onnx.load(str(OUT))
    meta = {
        "sample_rate": 44100, "audio_channels": 2, "num_stems": int(wrapper.num_stems),
        "stems": stems, "chunk_samples": SAMPLES, "n_fft": N_FFT, "hop_length": HOP,
        "win_length": WIN, "stft_freq_bins": int(spec_r.shape[2]),
        "stft_time_frames": int(spec_r.shape[3]), "opset": OPSET,
    }
    for k, v in meta.items():
        prop = m.metadata_props.add()
        prop.key = k
        prop.value = v if isinstance(v, str) else json.dumps(v)
    onnx.save(m, str(OUT))

    print("Computing reference output…")
    with torch.no_grad():
        ref_r, ref_i = wrapper(spec_r, spec_i)
        ref_audio = istft_from_spec(ref_r, ref_i, length=SAMPLES,
                                    n_fft=N_FFT, hop_length=HOP, win_length=WIN)
    np.savez(REF, input_audio=audio.numpy(), spec_real=spec_r.numpy(),
             spec_imag=spec_i.numpy(), out_spec_real=ref_r.numpy(),
             out_spec_imag=ref_i.numpy(), ref_audio=ref_audio.numpy(),
             samples=np.int64(SAMPLES))
    print(f"Saved reference to {REF}")


if __name__ == "__main__":
    main()
