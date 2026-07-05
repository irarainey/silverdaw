#pragma once

namespace silverdaw::stems
{

// Intra-op thread count for offline ONNX stem inference.
//
// Transformer stem models (RoFormer / htdemucs) are compute-bound, so more real
// cores means faster inference — but only up to a point, and NOT across
// hyperthread siblings. Two logical processors sharing one physical core fight
// over the same execution units, and the ops synchronise at every boundary, so
// oversubscribing a hyperthreaded CPU (e.g. running 18 threads on 6 P-cores + HT
// + E-cores) actually runs SLOWER than one thread per physical core.
//
// So this uses the physical-core count (P-cores AND E-cores — on modern
// non-hyperthreaded hybrid CPUs the E-cores add genuine throughput with no
// sibling contention), bounded by the historical `logical - 2` default that
// reserves headroom for the websocket + message threads:
//   - Hyperthreaded CPUs collapse to one thread per physical core, dropping the
//     HT siblings that caused the slowdown.
//   - Non-hyperthreaded CPUs keep `logical - 2`, the long-standing fast value.
//
// Falls back to `logical - 2` when physical-core detection is unavailable, and
// never returns fewer than one.
int inferenceIntraOpThreads() noexcept;

} // namespace silverdaw::stems
