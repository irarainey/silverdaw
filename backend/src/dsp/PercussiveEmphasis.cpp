#include "PercussiveEmphasis.h"

#include <algorithm>
#include <cmath>

namespace silverdaw
{
namespace
{
    /** Kernel length whose centred moving average has roughly the requested
        cutoff. A boxcar of length N first nulls at sampleRate/N. Forced odd so
        the kernel is symmetric about a single centre sample and the delay is
        exactly zero rather than a half-sample. Note the cascade of two passes
        attenuates faster than one, so the true -3 dB corner sits below the
        nominal figure; the constants name the intent, not a measured corner. */
    int boxcarLengthForCutoff(double sampleRate, double cutoffHz)
    {
        if (cutoffHz <= 0.0 || sampleRate <= 0.0)
            return 1;

        int length = static_cast<int>(std::lround(0.44 * sampleRate / cutoffHz));
        length = std::max(length, 1);
        if (length % 2 == 0)
            ++length;
        return length;
    }

    /** One centred boxcar pass over a REFLECTED extension of the input.
        Reflection matters for correctness, not tidiness: simply shrinking the
        window at the edges would make the operator time-varying there, so its
        impulse response would stop being symmetric and onsets in the first and
        last few milliseconds would acquire a small timing bias. Mirroring keeps
        one fixed symmetric kernel everywhere, so the zero-delay property holds
        at the very start and end of a file as well as in the middle. */
    void centredBoxcarPass(const std::vector<float>& in, std::vector<float>& out, int length)
    {
        const int n = static_cast<int>(in.size());
        out.resize(in.size());

        if (length <= 1 || n == 0)
        {
            out = in;
            return;
        }

        const int half = length / 2;

        // Reflect about the first and last samples, clamping the reflected
        // index so inputs shorter than the kernel stay in range.
        auto sampleAt = [&in, n](int index) -> double {
            if (index < 0) index = -index;
            if (index >= n) index = 2 * (n - 1) - index;
            index = std::clamp(index, 0, n - 1);
            return in[static_cast<size_t>(index)];
        };

        double sum = 0.0;
        for (int i = -half; i <= half; ++i)
            sum += sampleAt(i);

        const double norm = 1.0 / static_cast<double>(length);
        for (int i = 0; i < n; ++i)
        {
            out[static_cast<size_t>(i)] = static_cast<float>(sum * norm);
            sum -= sampleAt(i - half);
            sum += sampleAt(i + half + 1);
        }
    }
} // namespace

std::vector<float> zeroPhaseLowPass(const std::vector<float>& in, double sampleRate, double cutoffHz, int passes)
{
    std::vector<float> current = in;
    if (in.empty() || passes < 1)
        return current;

    const int length = boxcarLengthForCutoff(sampleRate, cutoffHz);
    if (length <= 1)
        return current;

    std::vector<float> scratch;
    for (int pass = 0; pass < passes; ++pass)
    {
        centredBoxcarPass(current, scratch, length);
        current.swap(scratch);
    }
    return current;
}

std::vector<float> emphasisePercussiveContent(const std::vector<float>& mono, double sampleRate)
{
    if (sampleRate <= 0.0)
        return mono;

    const int lowLength = boxcarLengthForCutoff(sampleRate, kPercussiveLowBandHz);
    // Too short to filter meaningfully: returned unaltered rather than reduced
    // to near-silence by a window spanning the whole signal.
    if (mono.size() < static_cast<size_t>(lowLength) * 4)
        return mono;

    const std::vector<float> lowBand = zeroPhaseLowPass(mono, sampleRate, kPercussiveLowBandHz);
    // The high band is the complement of a low-pass rather than an independent
    // filter, so the bands stay sample-aligned by construction and sum back to
    // the input exactly when all three weights are 1.
    const std::vector<float> belowHigh = zeroPhaseLowPass(mono, sampleRate, kPercussiveHighBandHz);

    std::vector<float> out(mono.size());
    for (size_t i = 0; i < mono.size(); ++i)
    {
        const float midBand = belowHigh[i] - lowBand[i];
        const float highBand = mono[i] - belowHigh[i];
        out[i] = lowBand[i] + kPercussiveMidBandGain * midBand + kPercussiveHighBandGain * highBand;
    }

    float inPeak = 0.0f;
    float outPeak = 0.0f;
    for (size_t i = 0; i < mono.size(); ++i)
    {
        inPeak = std::max(inPeak, std::abs(mono[i]));
        outPeak = std::max(outPeak, std::abs(out[i]));
    }

    // Restore the original peak so downstream stages using absolute onset
    // thresholds see the level they were tuned against. The gain is CAPPED: on
    // material living entirely in the attenuated mid, what survives is filter
    // leakage and noise, and an uncapped restoration would lift that to full
    // scale and present it as onsets.
    if (inPeak > kPercussiveSilenceFloor && outPeak > kPercussiveSilenceFloor)
    {
        const float gain = std::min(inPeak / outPeak, kPercussiveMaxRestoreGain);
        for (auto& sample : out)
            sample *= gain;
    }

    return out;
}

} // namespace silverdaw
