#include "Dereverberator.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include <juce_dsp/juce_dsp.h>

namespace silverdaw
{
namespace
{

constexpr int kFftOrder = 11;            // 2048-point FFT
constexpr int kFftSize = 1 << kFftOrder; // 2048
constexpr int kHop = kFftSize / 4;       // 512 (75% overlap; Hann is COLA at N/4)
constexpr float kEps = 1.0e-12f;

// Overlap-add normalisation floor. The window-sum-of-squares reaches ~1.5 in the
// fully-overlapped interior (periodic Hann at 75% overlap), but ramps up from ~0 at
// the very first/last samples where only the taper of one or two frames covers them.
// Dividing the (gain-modified) accumulator by that near-zero coverage explodes into
// huge outlier samples, so any sample whose coverage is below a sane fraction of the
// steady state is left as the dry signal instead. 0.1·1.5 keeps the well-covered
// body processed while refusing to reconstruct the ill-conditioned edges.
constexpr float kNormFloor = 0.15f;

// Only pull reverb out of the vocal-relevant band; below/above this the estimate
// is unreliable (rumble, air) and cutting it would only dull the stem.
constexpr double kBandLowHz = 120.0;
constexpr double kBandHighHz = 12000.0;

// A whole-band frame power jump beyond this ratio over the previous frame is treated
// as an onset (a vocal attack / new phrase) and the whole frame is left untouched, so
// transients and the start of sustained notes are never mistaken for reverb tail and
// pumped. Detecting it on the broadband total (not per bin) is what lets a decaying
// reverb tail — whose per-bin energy fluctuates but whose total does not jump — still
// be reduced while genuine attacks are protected.
constexpr float kOnsetRatio = 1.6f;

// Temporal smoothing of the per-bin gain (0 = none, →1 = heavy). Softens frame-to-
// frame gain changes so the reduction never introduces musical-noise warble.
constexpr float kGainSmooth = 0.5f;

// Recursive smoothing of the observed per-bin power spectrum before it feeds the
// reverb estimate (a running ~40 ms average), so the estimate isn't built from
// spiky single-frame magnitudes (a prime source of musical noise).
constexpr float kPsdSmooth = 0.6f;

// Throttle the progress callback: a per-frame call would dominate the pass cost.
constexpr int kProgressEveryFrames = 96;

// Per-strength tuning for the recursive statistical late-reverb subtraction (a
// Lebart/Habets-style estimate). `wet` is the dry/processed blend; `floor` is the
// spectral power floor (the hardest a bin's power may be cut → min gain sqrt(floor),
// so a bin is never nulled → no "underwater"/musical-noise artefact); `delayFrames`
// is the pre-delay that protects the direct sound + early reflections; `tailScale`
// scales the recursive reverb-PSD estimate; `revCap` caps that estimate to a fraction
// of the present power so a steady note is never crushed to the floor; `alpha` is the
// over-subtraction factor; `t60` is the reverb hold (−60 dB) in seconds (→ the
// recursive decay). Because the estimate is present continuously (not only in gaps),
// this removes reverb embedded IN sustained singing — which is why it is audibly
// stronger than a decay-only model, at the cost of drying held notes somewhat.
struct DereverbParams
{
    float wet;
    float floor;
    int delayFrames;
    float tailScale;
    float revCap;
    float alpha;
    double t60;
};

DereverbParams paramsFor(DereverbStrength strength) noexcept
{
    switch (strength)
    {
        case DereverbStrength::Light: return {0.70f, 0.25f, 3, 0.40f, 0.85f, 1.00f, 0.60};
        // Strong now pushes the subtraction hard: full wet, a deeper spectral floor, a
        // heavier over-subtraction (alpha) and reverb-PSD weight (tailScale), a higher
        // cap and a longer modelled tail (t60). This is only sane because the downstream
        // VocalRestorer reliably matches the loud-frame LEVEL back and lifts presence —
        // so aggressive drying no longer leaves the vocal quiet or dull. The floor + cap
        // + time/frequency gain smoothing still bound it away from musical-noise territory.
        case DereverbStrength::Strong: return {1.00f, 0.07f, 4, 1.00f, 0.97f, 1.55f, 1.20};
        case DereverbStrength::Medium:
        default: return {0.88f, 0.14f, 3, 0.60f, 0.90f, 1.20f, 0.80};
    }
}

bool finiteBuffer(const juce::AudioBuffer<float>& b) noexcept
{
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
    {
        const float* d = b.getReadPointer(ch);
        for (int i = 0; i < b.getNumSamples(); ++i)
            if (!std::isfinite(d[i])) return false;
    }
    return true;
}

} // namespace

DereverbStrength dereverbStrengthFromString(const juce::String& text) noexcept
{
    const auto t = text.trim().toLowerCase();
    if (t == "light") return DereverbStrength::Light;
    if (t == "strong") return DereverbStrength::Strong;
    return DereverbStrength::Medium;
}

const char* dereverbStrengthToString(DereverbStrength strength) noexcept
{
    switch (strength)
    {
        case DereverbStrength::Light: return "light";
        case DereverbStrength::Strong: return "strong";
        case DereverbStrength::Medium:
        default: return "medium";
    }
}

void Dereverberator::process(juce::AudioBuffer<float>& buffer, double sampleRate,
                             DereverbStrength strength, const std::function<void(double)>& onProgress)
{
    const int channels = buffer.getNumChannels();
    const int frames = buffer.getNumSamples();
    // Guaranteed no-op on anything we can't safely STFT, so the stem is never harmed.
    if (channels <= 0 || frames < kFftSize || sampleRate <= 0.0) return;
    if (!finiteBuffer(buffer)) return;

    const auto p = paramsFor(strength);
    const int numBins = kFftSize / 2 + 1;
    const int delay = juce::jmax(1, p.delayFrames);

    // Recursive reverb-PSD decay per hop, in the POWER domain: −60 dB (a factor of
    // 1000 in power) over t60 seconds. (Note: power, so 2·ln(1000); an amplitude-style
    // 10^(-3·…) constant would decay half as fast and under-model the tail.)
    const double hopSec = static_cast<double>(kHop) / sampleRate;
    const float gammaSq =
        static_cast<float>(std::exp(-2.0 * hopSec * std::log(1000.0) / juce::jmax(1.0e-3, p.t60)));

    // Band bins (inclusive); bins outside pass through untouched.
    const int lowBin =
        juce::jlimit(0, numBins - 1, static_cast<int>(std::floor(kBandLowHz * kFftSize / sampleRate)));
    const int highBin =
        juce::jlimit(0, numBins - 1, static_cast<int>(std::ceil(kBandHighHz * kFftSize / sampleRate)));

    juce::dsp::FFT fft(kFftOrder);

    // Periodic Hann (analysis + synthesis); COLA normalisation is the running sum of
    // window^2 applied once at the end (same scheme as VocalDebleeder).
    std::vector<float> win(static_cast<size_t>(kFftSize));
    for (int n = 0; n < kFftSize; ++n)
        win[static_cast<size_t>(n)] =
            0.5f * (1.0f - std::cos(2.0f * juce::MathConstants<float>::pi * static_cast<float>(n) /
                                    static_cast<float>(kFftSize)));

    // Per-channel FFT scratch (2*N packed complex) + overlap-add accumulator.
    std::vector<std::vector<float>> spec(static_cast<size_t>(channels),
                                         std::vector<float>(static_cast<size_t>(2 * kFftSize), 0.0f));
    std::vector<std::vector<float>> outAccum(static_cast<size_t>(channels),
                                             std::vector<float>(static_cast<size_t>(frames), 0.0f));
    std::vector<float> normAccum(static_cast<size_t>(frames), 0.0f);

    // Per-bin state.
    std::vector<float> pxx(static_cast<size_t>(numBins), 0.0f);      // smoothed observed PSD
    std::vector<float> revPsd(static_cast<size_t>(numBins), 0.0f);   // recursive late-reverb PSD
    std::vector<float> prevGain(static_cast<size_t>(numBins), 1.0f);
    std::vector<float> gainRaw(static_cast<size_t>(numBins), 1.0f);  // per-frame gains before freq-smooth
    // Ring of the last `delay` frames' smoothed PSD per bin.
    std::vector<float> pxxHist(static_cast<size_t>(delay) * static_cast<size_t>(numBins), 0.0f);
    // Broadband (whole-band) power of the previous frame, for onset detection.
    double prevFrameTotal = 0.0;

    int totalFrames = 0;
    for (int start = 0; start + kFftSize <= frames; start += kHop) ++totalFrames;

    int frameIdx = 0;
    for (int start = 0; start + kFftSize <= frames; start += kHop, ++frameIdx)
    {
        for (int ch = 0; ch < channels; ++ch)
        {
            auto& s = spec[static_cast<size_t>(ch)];
            std::fill(s.begin(), s.end(), 0.0f);
            const float* in = buffer.getReadPointer(ch);
            for (int n = 0; n < kFftSize; ++n)
                s[static_cast<size_t>(n)] = in[start + n] * win[static_cast<size_t>(n)];
            fft.performRealOnlyForwardTransform(s.data());
        }

        // The delay-line slot holds frame (frameIdx-delay)'s smoothed PSD until we overwrite it.
        float* pxxDelayed = &pxxHist[static_cast<size_t>(frameIdx % delay) * static_cast<size_t>(numBins)];

        // Pass 1: per-bin mean power (shared across channels → one gain, stereo intact),
        // recursively-smoothed PSD, and the whole-band total for BROADBAND onset detection
        // (a vocal attack lifts many bins at once — protect it; a reverb tail does not).
        double frameTotal = 0.0;
        for (int bin = 0; bin < numBins; ++bin)
        {
            const size_t re = static_cast<size_t>(2 * bin);
            const size_t im = re + 1;
            float power = 0.0f;
            for (int ch = 0; ch < channels; ++ch)
            {
                const auto& s = spec[static_cast<size_t>(ch)];
                power += s[re] * s[re] + s[im] * s[im];
            }
            power /= static_cast<float>(channels);
            pxx[static_cast<size_t>(bin)] =
                kPsdSmooth * pxx[static_cast<size_t>(bin)] + (1.0f - kPsdSmooth) * power;
            if (bin >= lowBin && bin <= highBin) frameTotal += pxx[static_cast<size_t>(bin)];
        }
        const bool frameOnset = frameTotal > kOnsetRatio * std::max(prevFrameTotal, static_cast<double>(kEps));
        prevFrameTotal = frameTotal;

        // Pass 2: recursively accumulate the late-reverb PSD (a decayed sum of past PSD,
        // so the estimate is diffuse across lags, not a single-tap comb) and compute the
        // over-subtracted, floored gain per bin into `gainRaw`.
        for (int bin = 0; bin < numBins; ++bin)
        {
            const float px = pxx[static_cast<size_t>(bin)];
            // Feed the recursion with the delayed PSD once the delay line is primed.
            const float feed = (frameIdx >= delay) ? pxxDelayed[static_cast<size_t>(bin)] : 0.0f;
            const float rev =
                gammaSq * revPsd[static_cast<size_t>(bin)] + (1.0f - gammaSq) * feed;
            revPsd[static_cast<size_t>(bin)] = rev;

            const bool inBand = (bin >= lowBin && bin <= highBin);
            float g = 1.0f;
            if (inBand && !frameOnset)
            {
                // Cap the estimate so a steady note (rev ≈ px) is never crushed to the floor.
                const float revEst = std::min(p.tailScale * rev, p.revCap * px);
                // Over-subtraction as a POWER ratio (1 − α·rev/px), floored. The ratio form
                // degrades gracefully for a near-silent bin (rev → 0 with px → 0 gives ratio
                // → 1), so silence is never wrongly attenuated (nor drags neighbours down via
                // the frequency smoothing below).
                const float ratio = juce::jlimit(p.floor, 1.0f, 1.0f - p.alpha * revEst / (px + kEps));
                const float raw = std::sqrt(ratio);
                const float sm = kGainSmooth * prevGain[static_cast<size_t>(bin)] + (1.0f - kGainSmooth) * raw;
                prevGain[static_cast<size_t>(bin)] = sm;
                g = (1.0f - p.wet) + p.wet * sm;
                if (g > 1.0f) g = 1.0f; // strictly attenuating
            }
            else
            {
                // Onset (protected) or out-of-band: reset the smoother to unity so the next
                // masked frame ramps down from 1.0 (no post-attack duck).
                prevGain[static_cast<size_t>(bin)] = 1.0f;
            }
            gainRaw[static_cast<size_t>(bin)] = g;
        }

        // Copy this frame's smoothed PSD into the delay slot (after the read above).
        for (int bin = 0; bin < numBins; ++bin)
            pxxDelayed[static_cast<size_t>(bin)] = pxx[static_cast<size_t>(bin)];

        // Pass 3: smooth the gain across FREQUENCY (3-bin triangular) to suppress isolated
        // per-bin spikes (musical noise), then apply to each bin + its conjugate mirror.
        for (int bin = 0; bin < numBins; ++bin)
        {
            const float gl = gainRaw[static_cast<size_t>(std::max(0, bin - 1))];
            const float gc = gainRaw[static_cast<size_t>(bin)];
            const float gr = gainRaw[static_cast<size_t>(std::min(numBins - 1, bin + 1))];
            const float g = 0.25f * gl + 0.5f * gc + 0.25f * gr;

            const size_t re = static_cast<size_t>(2 * bin);
            const int mirror = (bin == 0 || bin == kFftSize / 2) ? -1 : (kFftSize - bin);
            for (int ch = 0; ch < channels; ++ch)
            {
                auto& s = spec[static_cast<size_t>(ch)];
                s[re] *= g;
                s[re + 1] *= g;
                if (mirror >= 0)
                {
                    const size_t mre = static_cast<size_t>(2 * mirror);
                    s[mre] *= g;
                    s[mre + 1] *= g;
                }
            }
        }

        for (int ch = 0; ch < channels; ++ch)
        {
            auto& s = spec[static_cast<size_t>(ch)];
            fft.performRealOnlyInverseTransform(s.data());
            auto& acc = outAccum[static_cast<size_t>(ch)];
            for (int n = 0; n < kFftSize; ++n)
            {
                const float w = win[static_cast<size_t>(n)];
                acc[static_cast<size_t>(start + n)] += s[static_cast<size_t>(n)] * w;
                if (ch == 0) normAccum[static_cast<size_t>(start + n)] += w * w;
            }
        }

        if (onProgress && totalFrames > 0 && (frameIdx % kProgressEveryFrames) == 0)
            onProgress(static_cast<double>(frameIdx) / static_cast<double>(totalFrames));
    }

    // Normalise the overlap-add into `outAccum`; samples whose window coverage is below
    // the normalisation floor (the low-overlap edges) keep the dry signal, so the
    // ill-conditioned edge division can never blow up into huge outlier samples. Verify
    // finiteness too so a stray NaN in the reconstruction can never reach the stem — on
    // any non-finite value we bail and leave the buffer untouched (all-or-nothing).
    for (int ch = 0; ch < channels; ++ch)
    {
        const float* dry = buffer.getReadPointer(ch);
        auto& acc = outAccum[static_cast<size_t>(ch)];
        for (int i = 0; i < frames; ++i)
        {
            const float norm = normAccum[static_cast<size_t>(i)];
            const float v = norm > kNormFloor ? acc[static_cast<size_t>(i)] / norm : dry[i];
            if (!std::isfinite(v)) return;
            acc[static_cast<size_t>(i)] = v;
        }
    }
    for (int ch = 0; ch < channels; ++ch)
    {
        float* out = buffer.getWritePointer(ch);
        const auto& acc = outAccum[static_cast<size_t>(ch)];
        for (int i = 0; i < frames; ++i) out[i] = acc[static_cast<size_t>(i)];
    }
    if (onProgress) onProgress(1.0);
}

} // namespace silverdaw
