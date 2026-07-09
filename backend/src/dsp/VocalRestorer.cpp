#include "VocalRestorer.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include <juce_core/juce_core.h>

namespace silverdaw
{
namespace
{

constexpr int kMaxChannels = 2;

// Peak ceiling and soft-knee for the output limiter. Samples below the knee pass
// through untouched (the make-up is fully preserved for the bulk of the vocal);
// above it they are smoothly rounded so the peak asymptotes to — but never reaches
// — the ceiling. A per-sample soft-knee (not a single whole-buffer scalar) means one
// stray transient can't pull the entire stem quieter, and it never hard-clips.
constexpr float kPeakCeiling = 0.9989f; // ~ -0.01 dBFS
constexpr float kSoftKnee = 0.90f;

// Bounds on the level-match make-up. The restorer only ever RESTORES level, never
// reduces it (min 1.0), so it can never be the thing that makes a stem quieter — its
// whole job is to undo the de-reverb's level drop. The upper bound is generous
// (~+12 dB) because strong de-reverb on a wet vocal can remove a lot of energy; the
// soft-knee limiter downstream stops that boost from ever clipping.
constexpr float kMinMakeup = 1.0f;  //  never attenuate
constexpr float kMaxMakeup = 3.98f; // ~ +12 dB

// Active-loudness gate: ~50 ms blocks, counting only blocks within 20 dB of the
// loudest, so gaps/tails/silence are excluded from the loudness figure.
constexpr double kBlockSeconds = 0.05;
constexpr float kGateRatio = 0.01f; // -20 dB in power

inline float softClip(float x) noexcept
{
    const float a = std::abs(x);
    if (a <= kSoftKnee) return x;
    const float sign = (x < 0.0f) ? -1.0f : 1.0f;
    const float range = kPeakCeiling - kSoftKnee;
    return sign * (kSoftKnee + range * std::tanh((a - kSoftKnee) / range));
}

// Active (loud-frame) RMS via a sample accessor, so it can run over either an
// AudioBuffer (the pre-de-reverb reference) or the scratch output (the restored
// stem) without copying. Two passes: find the loudest ~50 ms block, then RMS only
// the blocks whose energy clears the gate — silence and reverb tails are ignored.
template <typename Sampler>
float activeLoudnessImpl(int channels, int frames, double sampleRate, Sampler sample) noexcept
{
    if (channels <= 0 || frames <= 0 || sampleRate <= 0.0) return 0.0f;
    const int block = juce::jmax(1, static_cast<int>(kBlockSeconds * sampleRate));
    const int numBlocks = (frames + block - 1) / block;

    double maxMs = 0.0;
    std::vector<double> blockMs(static_cast<size_t>(numBlocks), 0.0);
    for (int b = 0; b < numBlocks; ++b)
    {
        const int s0 = b * block;
        const int s1 = juce::jmin(frames, s0 + block);
        double sum = 0.0;
        int count = 0;
        for (int ch = 0; ch < channels; ++ch)
            for (int i = s0; i < s1; ++i)
            {
                const float v = sample(ch, i);
                sum += static_cast<double>(v) * v;
                ++count;
            }
        const double ms = (count > 0) ? sum / count : 0.0;
        blockMs[static_cast<size_t>(b)] = ms;
        maxMs = std::max(maxMs, ms);
    }
    if (maxMs <= 0.0) return 0.0f;

    const double gate = maxMs * static_cast<double>(kGateRatio);
    double sum = 0.0;
    int n = 0;
    for (int b = 0; b < numBlocks; ++b)
        if (blockMs[static_cast<size_t>(b)] >= gate)
        {
            sum += blockMs[static_cast<size_t>(b)];
            ++n;
        }
    return (n > 0) ? static_cast<float>(std::sqrt(sum / n)) : 0.0f;
}

// Per-strength restoration tuning: two high-shelves for the tonal (presence/air)
// restoration. `presence*` lifts the 3–5 kHz band where the dulling is most audible;
// `air*` adds a little top-octave sparkle ABOVE the sibilant band (~5–9 kHz) so it
// doesn't sharpen "ess" sounds the de-reverb left untouched. Values stay modest on
// purpose — this compensates the de-reverb, it is not an enhancer. The LEVEL is
// handled separately by the active-loudness match, not a fixed dB here.
struct RestoreParams
{
    float presenceDb;
    double presenceHz;
    float airDb;
    double airHz;
};

RestoreParams paramsFor(DereverbStrength strength) noexcept
{
    switch (strength)
    {
        case DereverbStrength::Light: return {0.75f, 3500.0, 0.5f, 10000.0};
        case DereverbStrength::Strong: return {2.0f, 4000.0, 1.0f, 10000.0};
        case DereverbStrength::Medium:
        default: return {1.5f, 3800.0, 0.75f, 10000.0};
    }
}

// Transposed-direct-form-II biquad with per-channel state. The high-shelf design is
// the standard RBJ cookbook shelf (same maths as ToneEq), here as a small offline
// filter so the real-time ToneEq class isn't dragged into the worker-thread path.
struct Biquad
{
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f, a1 = 0.0f, a2 = 0.0f;
    float z1[kMaxChannels] = {0.0f, 0.0f};
    float z2[kMaxChannels] = {0.0f, 0.0f};

    inline float process(int ch, float x) noexcept
    {
        const float y = b0 * x + z1[ch];
        z1[ch] = b1 * x - a1 * y + z2[ch];
        z2[ch] = b2 * x - a2 * y;
        return y;
    }

    void setHighShelf(double freq, float gainDb, double sampleRate) noexcept
    {
        // A flat shelf (S = 1); an identity fall-through when the gain is ~0.
        if (std::abs(gainDb) < 1.0e-3f)
        {
            b0 = 1.0f; b1 = 0.0f; b2 = 0.0f; a1 = 0.0f; a2 = 0.0f;
            return;
        }
        const double f = juce::jlimit(1.0, sampleRate * 0.49, freq);
        const double w0 = 2.0 * juce::MathConstants<double>::pi * f / sampleRate;
        const double cw = std::cos(w0);
        const double sw = std::sin(w0);
        const double A = std::pow(10.0, static_cast<double>(gainDb) / 40.0);
        // Flat shelf slope S = 1 → the bracket reduces to 2.
        const double alpha = (sw / 2.0) * std::sqrt(2.0);
        const double twoSqrtAAlpha = 2.0 * std::sqrt(A) * alpha;

        const double nb0 = A * ((A + 1.0) + (A - 1.0) * cw + twoSqrtAAlpha);
        const double nb1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cw);
        const double nb2 = A * ((A + 1.0) + (A - 1.0) * cw - twoSqrtAAlpha);
        const double a0 = (A + 1.0) - (A - 1.0) * cw + twoSqrtAAlpha;
        const double na1 = 2.0 * ((A - 1.0) - (A + 1.0) * cw);
        const double na2 = (A + 1.0) - (A - 1.0) * cw - twoSqrtAAlpha;

        if (! std::isfinite(a0) || std::abs(a0) < 1.0e-12)
        {
            b0 = 1.0f; b1 = 0.0f; b2 = 0.0f; a1 = 0.0f; a2 = 0.0f;
            return;
        }
        const double inv = 1.0 / a0;
        b0 = static_cast<float>(nb0 * inv);
        b1 = static_cast<float>(nb1 * inv);
        b2 = static_cast<float>(nb2 * inv);
        a1 = static_cast<float>(na1 * inv);
        a2 = static_cast<float>(na2 * inv);
    }
};

} // namespace

VocalRestorer::Result VocalRestorer::process(juce::AudioBuffer<float>& buffer, double sampleRate,
                                             DereverbStrength strength, float referenceLevel)
{
    Result result;
    result.referenceLevel = referenceLevel;

    const int channels = buffer.getNumChannels();
    const int frames = buffer.getNumSamples();
    if (channels <= 0 || channels > kMaxChannels || frames <= 0 || sampleRate <= 0.0) return result;

    // IIR shelves on a decaying/near-silent tail can emit denormals; on a worker
    // thread (which doesn't inherit the audio thread's FTZ/DAZ flags) that means a
    // large CPU-time hit. Flush-to-zero for the duration of the pass.
    const juce::ScopedNoDenormals noDenormals;

    // Guaranteed no-op on any non-finite input, so the stem is never harmed.
    for (int ch = 0; ch < channels; ++ch)
    {
        const float* d = buffer.getReadPointer(ch);
        for (int i = 0; i < frames; ++i)
            if (! std::isfinite(d[i])) return result;
    }

    const auto p = paramsFor(strength);

    Biquad presence, air;
    presence.setHighShelf(p.presenceHz, p.presenceDb, sampleRate);
    air.setHighShelf(p.airHz, p.airDb, sampleRate);

    // Filter into a scratch copy so a stray non-finite can be rejected wholesale
    // (all-or-nothing); the whole stem buffer is processed in one call (offline),
    // so the biquad state runs continuously with no block boundaries to click on.
    std::vector<std::vector<float>> out(static_cast<size_t>(channels),
                                        std::vector<float>(static_cast<size_t>(frames), 0.0f));
    for (int ch = 0; ch < channels; ++ch)
    {
        const float* in = buffer.getReadPointer(ch);
        auto& o = out[static_cast<size_t>(ch)];
        for (int i = 0; i < frames; ++i)
        {
            float x = in[i];
            x = presence.process(ch, x);
            x = air.process(ch, x);
            if (! std::isfinite(x)) return result; // reject the whole pass, leave buffer untouched
            o[static_cast<size_t>(i)] = x;
        }
    }

    // Level match: bring the shelved stem's ACTIVE loudness back to the reference the
    // caller captured before the de-reverb ran, so the subtraction's level drop is
    // undone. Measured on the loud frames only (of both signals), so the make-up
    // restores the voice without re-inflating the reverb tail the de-reverb removed
    // from the gaps. A single static gain → no pumping. Clamped, and skipped when
    // either level is unusable (silence / no reference).
    float makeup = 1.0f;
    if (referenceLevel > 0.0f)
    {
        const float processed = activeLoudnessImpl(
            channels, frames, sampleRate,
            [&out](int ch, int i) { return out[static_cast<size_t>(ch)][static_cast<size_t>(i)]; });
        result.processedLevel = processed;
        if (processed > 0.0f)
        {
            const float wanted = referenceLevel / processed;
            makeup = juce::jlimit(kMinMakeup, kMaxMakeup, wanted);
            result.clamped = (wanted < kMinMakeup) || (wanted > kMaxMakeup);
        }
    }
    result.makeup = makeup;
    result.makeupDb = 20.0f * std::log10(juce::jmax(1.0e-6f, makeup));

    // Apply the make-up, then a per-sample soft-knee limiter so the shelves/make-up
    // can never clip the stem, without a single peak dragging the whole vocal quieter
    // (a global scalar would). Below the knee the level is preserved exactly; above
    // it, peaks round smoothly to the ceiling. Applied equally per channel so the
    // stereo image is preserved.
    for (int ch = 0; ch < channels; ++ch)
    {
        float* dst = buffer.getWritePointer(ch);
        const auto& o = out[static_cast<size_t>(ch)];
        for (int i = 0; i < frames; ++i) dst[i] = softClip(o[static_cast<size_t>(i)] * makeup);
    }
    return result;
}

float VocalRestorer::activeLoudness(const juce::AudioBuffer<float>& buffer, double sampleRate) noexcept
{
    const int channels = buffer.getNumChannels();
    const int frames = buffer.getNumSamples();
    for (int ch = 0; ch < channels; ++ch)
    {
        const float* d = buffer.getReadPointer(ch);
        for (int i = 0; i < frames; ++i)
            if (! std::isfinite(d[i])) return 0.0f;
    }
    return activeLoudnessImpl(channels, frames, sampleRate,
                              [&buffer](int ch, int i) { return buffer.getSample(ch, i); });
}

} // namespace silverdaw
