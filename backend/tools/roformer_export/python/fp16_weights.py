"""
Halve disk size by storing Conv/MatMul/Gemm weight initializers as float16
with a Cast(fp16->fp32) inserted right after each one. Compute graph stays
fp32 so there's no precision loss on CPU/WASM. On WebGPU the EP may use
fp16 accumulators internally regardless — see the parity numbers in the
project README.

Technique borrowed from demucs-next/demucs/onnx.py.

Last step of the build pipeline. Input: graph from webgpu_friendly.py.
Output: ready-to-ship ONNX (~336 MB for BS-Roformer-SW 6-stem).
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


# Ops whose listed input indices are weight initializers we want to fp16.
WEIGHT_OP_INPUTS = {
    "Conv":          (1, 2),
    "ConvTranspose": (1, 2),
    "MatMul":        (0, 1),
    "Gemm":          (0, 1, 2),
}


def convert(in_path: Path, out_path: Path) -> None:
    print(f"Loading {in_path}")
    model = onnx.load(str(in_path))

    weight_init_names: set[str] = set()
    for node in model.graph.node:
        for idx in WEIGHT_OP_INPUTS.get(node.op_type, ()):
            if idx < len(node.input) and node.input[idx]:
                weight_init_names.add(node.input[idx])

    # Avoid rewriting initializers that are also produced by some node — those
    # aren't weights, they're constant-folded intermediates and casting them
    # would create a name collision.
    existing_outputs = {n.output[0] for n in model.graph.node if n.output}
    existing_inputs = {i.name for i in model.graph.input}

    new_inits = []
    cast_nodes = []
    converted = 0
    for init in model.graph.initializer:
        if (
            init.name in weight_init_names
            and init.data_type == TensorProto.FLOAT
            and init.name not in existing_outputs
            and init.name not in existing_inputs
        ):
            arr = numpy_helper.to_array(init).astype(np.float16)
            fp16_name = init.name + "_fp16"
            new_inits.append(numpy_helper.from_array(arr, name=fp16_name))
            cast_nodes.append(helper.make_node(
                "Cast", inputs=[fp16_name], outputs=[init.name],
                to=TensorProto.FLOAT, name=init.name + "_cast_to_fp32",
            ))
            converted += 1
        else:
            new_inits.append(init)

    print(f"Converted {converted} weight tensors to fp16")
    model.graph.ClearField("initializer")
    model.graph.initializer.extend(new_inits)

    # Cast nodes must precede their consumers in topological order.
    original_nodes = list(model.graph.node)
    model.graph.ClearField("node")
    model.graph.node.extend(cast_nodes + original_nodes)

    in_mb = in_path.stat().st_size / 1024 / 1024
    onnx.save(model, str(out_path))
    out_mb = out_path.stat().st_size / 1024 / 1024
    print(f"Size: {in_mb:.1f} MB -> {out_mb:.1f} MB ({100 * out_mb / in_mb:.1f}%)")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--in-path", required=True)
    p.add_argument("--out-path", required=True)
    args = p.parse_args()
    convert(Path(args.in_path), Path(args.out_path))
