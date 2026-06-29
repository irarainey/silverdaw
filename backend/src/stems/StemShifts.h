#pragma once

// Deterministic time-shift offsets for stem-separation test-time augmentation
// (TTA, the demucs `shifts` trick). htdemucs is translation-variant: running the
// model on a few small time-shifts of the input and averaging the realigned
// outputs cancels phase/edge artefacts (the "watery / metallic" swirl) on the
// separated stem. We use DETERMINISTIC offsets (not demucs' RNG) so a given
// render is bit-reproducible and unit-testable.
//
// Pure / header-only and free of any ONNX include so it links into the test
// suite and the offline tools without the inference engine.

#include <algorithm>
#include <vector>

namespace silverdaw
{

// Returns `shifts` sample offsets in `[0, maxShiftSamples]`, spread evenly and
// always starting at 0 (the un-shifted run). `shifts <= 1` yields `{0}` so the
// single-pass path is unchanged. Duplicate offsets (e.g. when maxShiftSamples is
// 0 or smaller than the spacing) are removed so no model run is wasted.
inline std::vector<int> shiftOffsetsFor(int shifts, int maxShiftSamples)
{
    const int n = std::max(1, shifts);
    const int maxShift = std::max(0, maxShiftSamples);
    std::vector<int> offsets;
    offsets.reserve(static_cast<size_t>(n));
    for (int k = 0; k < n; ++k)
    {
        // k = 0 -> 0; the rest fan out across the window without reaching the
        // far edge (matching demucs, which shifts by *up to* max_shift).
        const long long scaled = static_cast<long long>(k) * maxShift / n;
        offsets.push_back(static_cast<int>(scaled));
    }
    offsets.erase(std::unique(offsets.begin(), offsets.end()), offsets.end());
    return offsets;
}

} // namespace silverdaw
