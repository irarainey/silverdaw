#pragma once

#include <algorithm>
#include <thread>

namespace silverdaw::stems
{

// Intra-op thread count for offline ONNX stem inference.
//
// Inference is CPU-hungry: given the chance the ONNX Runtime pins every logical
// core at 100%. Two things must keep running DURING a separation, both on the
// backend: the loopback-websocket poll thread that flushes STEM_PROGRESS to the
// renderer, and the message thread that handles STEM_SEPARATE_CANCEL. Measured
// on a real run, leaving only ONE spare core starved both for the full length of
// each stem — ~23 s of progress messages buffered in transit and then burst-
// delivered at the stem boundary (the bar "froze" then jumped), and cancel
// lagging a whole stem. So reserve TWO logical cores: with genuine headroom the
// poll + message threads stay scheduled, progress streams smoothly as work
// happens, and cancellation lands within a segment. Inference is a little slower
// — an accepted trade for a long background task whose priority is visible
// responsiveness (and it pairs with disabling intra-op spinning so the reserved
// cores are truly free between ops).
//
// Never returns fewer than one. Falls back to a single thread when the core
// count is unknown (`hardware_concurrency()` may report 0).
inline int inferenceIntraOpThreads() noexcept
{
    const unsigned int cores = std::thread::hardware_concurrency();
    if (cores <= 3u) return static_cast<int>(std::max(1u, cores - 1u)); // tiny hosts: reserve one
    return static_cast<int>(cores - 2u);                               // otherwise reserve two
}

} // namespace silverdaw::stems
