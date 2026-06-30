"""
Validate an exported ONNX model against the saved PyTorch reference.

Loads the model with ORT-CPU (so accuracy is fp32-clean — useful for
asserting the export itself is faithful; the WebGPU EP will deviate a bit
more due to fp16 accumulators on M-series, see browser parity tests).

Run after each step of the build pipeline. Fails if max abs diff > 1e-3.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--onnx", required=True)
    p.add_argument("--reference", required=True, help="reference.npz from export_onnx.py")
    args = p.parse_args()

    size_mb = Path(args.onnx).stat().st_size / 1024 / 1024
    print(f"ONNX file: {args.onnx} ({size_mb:.1f} MB)")

    ref = np.load(args.reference)
    sess = ort.InferenceSession(args.onnx, providers=["CPUExecutionProvider"])
    out_r, out_i = sess.run(
        ["out_spec_real", "out_spec_imag"],
        {"spec_real": ref["spec_real"], "spec_imag": ref["spec_imag"]},
    )

    diff_r = np.abs(out_r - ref["out_spec_real"]).max()
    diff_i = np.abs(out_i - ref["out_spec_imag"]).max()
    ref_max = max(np.abs(ref["out_spec_real"]).max(), np.abs(ref["out_spec_imag"]).max())
    print(f"Spec max diff: real={diff_r:.3e}, imag={diff_i:.3e} (ref max abs {ref_max:.3e})")

    if max(diff_r, diff_i) < 1e-3:
        print("ONNX validation OK")
    else:
        raise SystemExit(f"ONNX validation FAILED — diff > 1e-3")


if __name__ == "__main__":
    main()
