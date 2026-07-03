#pragma once

#include <algorithm>
#include <thread>

namespace silverdaw::stems
{

// Intra-op thread count for offline ONNX stem inference.
//
// Inference is CPU-hungry: given the chance the ONNX Runtime pins every logical
// core at 100%. On a CPU-only machine (no GPU execution provider) that starves
// the Electron renderer and the OS compositor, so the separation-progress bar
// cannot repaint and the app looks frozen until each stem finishes. We reserve
// one logical core so the UI thread always gets scheduled and the progress bar
// keeps moving. The separation is a touch slower but stays visibly responsive,
// which is the priority for a long-running background task.
//
// Never returns fewer than one. Falls back to a single thread when the core
// count is unknown (`hardware_concurrency()` may report 0).
inline int inferenceIntraOpThreads() noexcept
{
    const unsigned int cores = std::thread::hardware_concurrency();
    if (cores <= 1) return 1;
    return static_cast<int>(cores - 1u);
}

} // namespace silverdaw::stems
