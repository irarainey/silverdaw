# ADR 0009 — Stem separation via ONNX Runtime (RoFormer + htdemucs backup)

- **Date:** 2026-06-09 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

Stem separation runs on the backend through **ONNX Runtime (DirectML)**. The
primary engine is the MIT-licensed RoFormer quality models (Mel-Band RoFormer
vocals + 4-stem BS-RoFormer drums/bass), used automatically once downloaded;
**htdemucs-ft** (MIT) is the backup, fetched on demand and used per stem when a
quality pack is absent. Runs on CPU by default with optional DirectML GPU and
automatic CPU fallback. Model weights are **downloaded on demand**, not bundled.
Model-aware post-separation cleanup (RNNoise + STFT de-bleed) runs in `dsp/`.

## Why

- ONNX Runtime + DirectML runs the models on CPU or any DX12 GPU without a CUDA
  dependency, fitting a Windows desktop consumer install.
- All chosen models are MIT-licensed, keeping the AGPL project (ADR 0010) clean.
- On-demand download keeps the installer small and stem features clearly gated
  until a model is present.

## Rejected alternatives

- **Bundling weights.** Bloats the installer and complicates licensing/updates.
- **CUDA/Torch runtime.** Heavy, GPU-vendor-locked, and hostile to a simple
  consumer install.
