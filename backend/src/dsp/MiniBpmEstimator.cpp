#include "MiniBpmEstimator.h"

#include <MiniBpm.h>

#include <algorithm>
#include <cmath>

namespace silverdaw
{

MiniBpmEstimate estimateTempoWithMiniBpm(const std::vector<float>& mono, double sampleRate,
                                         double minBpm, double maxBpm,
                                         const std::function<bool()>& shouldAbort)
{
    MiniBpmEstimate estimate;
    if (mono.empty() || sampleRate <= 0.0 || minBpm <= 0.0 || maxBpm <= minBpm)
    {
        return estimate;
    }

    breakfastquay::MiniBPM engine(static_cast<float>(sampleRate));
    engine.setBPMRange(minBpm, maxBpm);

    // Fed in blocks rather than one call so the sample count stays well inside
    // the `int` parameter even for the longest inputs the loader will produce.
    // The block boundary doubles as the only abort point MiniBPM offers.
    constexpr size_t kBlock = 1 << 16;
    for (size_t pos = 0; pos < mono.size(); pos += kBlock)
    {
        if (shouldAbort && shouldAbort())
        {
            estimate.abandoned = true;
            return estimate;
        }
        const size_t count = std::min(kBlock, mono.size() - pos);
        engine.process(mono.data() + pos, static_cast<int>(count));
    }

    const double bpm = engine.estimateTempo();
    if (std::isfinite(bpm) && bpm > 0.0)
    {
        estimate.bpm = bpm;
    }
    estimate.candidates = engine.getTempoCandidates();
    return estimate;
}

double foldBpmIntoRange(double bpm, double minBpm, double maxBpm)
{
    if (!std::isfinite(bpm) || bpm <= 0.0 || minBpm <= 0.0 || maxBpm <= minBpm) return 0.0;

    double folded = bpm;
    // Guarded iteration counts: a pathological range narrower than one octave
    // could otherwise never satisfy both bounds and spin forever.
    for (int i = 0; i < 8 && folded < minBpm; ++i) folded *= 2.0;
    for (int i = 0; i < 8 && folded > maxBpm; ++i) folded /= 2.0;
    return folded;
}

} // namespace silverdaw
