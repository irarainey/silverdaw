#include "DrumEnhancer.h"

#include "EnhancerDsp.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace silverdaw
{
namespace
{

using enhancer_dsp::applyHighPass;
using enhancer_dsp::expansionGainDb;
using enhancer_dsp::kContrastBypassDb;
using enhancer_dsp::kContrastHalfRangeDb;
using enhancer_dsp::kSilenceFloor;
using enhancer_dsp::percentile;
using enhancer_dsp::sanitiseInPlace;
using enhancer_dsp::softLimitInPlace;

// Per-strength tuning. The subsonic corner clears DC/rumble only. The expander
// threshold sits `thresholdBelowDb` under a robust high-percentile "active drum
// level", so gaps fall below it while hits stay above. `rangeDb` caps the
// attenuation so the expander can never fully gate (chop) a tail; `ratio` sets
// how hard it pulls below the threshold; `releaseMs`/`holdMs` shape how it
// closes into the gaps.
struct StrengthParams
{
    double highPassHz;       // subsonic high-pass corner (DC/rumble only)
    double thresholdBelowDb; // expander threshold, in dB below the active level
    double ratio;            // downward-expansion ratio (> 1)
    double rangeDb;          // maximum attenuation the expander may apply
    double holdMs;           // hold before the gain starts releasing
    double releaseMs;        // release time as the gain closes into a gap
    double kneeDb;           // soft-knee width around the threshold
};

StrengthParams paramsFor(DrumEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case DrumEnhanceStrength::Light:
            return {20.0, 33.0, 1.4, 6.0, 20.0, 180.0, 6.0};
        case DrumEnhanceStrength::Strong:
            return {28.0, 24.0, 2.3, 11.0, 10.0, 110.0, 6.0};
        case DrumEnhanceStrength::Medium:
        default:
            return {25.0, 28.0, 1.8, 9.0, 15.0, 140.0, 6.0};
    }
}

// Attack-emphasis amount for the transient designer (dB of extra gain applied to
// the leading edge of a hit when the fast envelope outruns the slow one). Scaled
// by strength; kept modest so the punch reads as tighter, not as distortion.
double transientBoostDbFor(DrumEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case DrumEnhanceStrength::Light: return 2.0;
        case DrumEnhanceStrength::Strong: return 5.0;
        case DrumEnhanceStrength::Medium:
        default: return 3.5;
    }
}

// Window over which the level envelope is measured for the percentile statistics
// that anchor the expander threshold. ~10 ms balances transient resolution with
// a stable estimate.
constexpr double kEnvelopeWindowMs = 10.0;

// Cross-channel sample detector: the loudest channel drives one shared gain so
// the stereo image and kit balance are preserved. Summing L+R is avoided because
// phasey separated material can cancel.
inline double sampleDetector(const juce::AudioBuffer<float>& buffer, int i) noexcept
{
    double d = 0.0;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        d = std::max(d, std::abs(static_cast<double>(buffer.getSample(ch, i))));
    return d;
}

// One short-window peak level per hop, used to derive robust percentile
// statistics for the threshold. Returns the window-peak series (linear).
std::vector<double> windowPeaks(const juce::AudioBuffer<float>& buffer, double sampleRate) noexcept
{
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const int win = std::max(1, static_cast<int>(kEnvelopeWindowMs * 0.001 * fs));
    const int numSamples = buffer.getNumSamples();

    std::vector<double> peaks;
    peaks.reserve(static_cast<size_t>(numSamples / win) + 1);
    for (int start = 0; start < numSamples; start += win)
    {
        const int end = std::min(start + win, numSamples);
        double peak = 0.0;
        for (int i = start; i < end; ++i)
            peak = std::max(peak, sampleDetector(buffer, i));
        peaks.push_back(peak);
    }
    return peaks;
}

// Wide-band downward expander with an instant attack + hold + slow release
// envelope. Instant attack keeps the envelope pinned to the loudest recent peak
// so transient onsets are never dulled; the hold then release closes the gain
// smoothly into the gaps. A single shared gain is applied to every channel.
void applyExpander(juce::AudioBuffer<float>& buffer, double sampleRate,
                   double thresholdDb, const StrengthParams& params, double rangeDb) noexcept
{
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const double slope = params.ratio - 1.0;
    const double aRel = std::exp(-1.0 / (params.releaseMs * 0.001 * fs));
    const int holdSamples = std::max(0, static_cast<int>(params.holdMs * 0.001 * fs));

    const int numCh = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();

    // Prime the envelope on the first sample so a stem that opens on a hit does
    // not fade in late.
    double env = sampleDetector(buffer, 0);
    int holdCounter = env > 0.0 ? holdSamples : 0;

    for (int i = 0; i < numSamples; ++i)
    {
        const double detector = sampleDetector(buffer, i);
        if (detector >= env)
        {
            env = detector; // instant attack
            holdCounter = holdSamples;
        }
        else if (holdCounter > 0)
        {
            --holdCounter; // hold at the recent peak
        }
        else
        {
            env = aRel * env + (1.0 - aRel) * detector; // slow release
        }

        const double envDb = 20.0 * std::log10(env + 1.0e-9);
        const float gain = static_cast<float>(
            std::pow(10.0, expansionGainDb(envDb - thresholdDb, slope, params.kneeDb, rangeDb) / 20.0));

        for (int ch = 0; ch < numCh; ++ch)
            buffer.getWritePointer(ch)[i] *= gain;
    }
}

// Cleanup stage: the subsonic-cleared buffer is gated by a downward expander
// anchored to a robust active level, with contrast-based self-bypass for dense or
// continuous material. Implemented as a helper so its early returns skip only the
// cleanup, never the enhancement stage that follows.
void applyCleanupExpander(juce::AudioBuffer<float>& buffer, double sampleRate,
                          const StrengthParams& params) noexcept
{
    // Anchor the threshold to a robust high percentile of the level so a single
    // loud transient cannot skew it, and read the gap floor for the contrast
    // guard below.
    const auto peaks = windowPeaks(buffer, sampleRate);
    const double activeLevel = percentile(peaks, 0.95);
    if (activeLevel <= kSilenceFloor) return; // silent after the high-pass

    const double gapFloor = percentile(peaks, 0.20);
    const double activeDb = 20.0 * std::log10(activeLevel + 1.0e-9);
    const double gapDb = 20.0 * std::log10(std::max(gapFloor, static_cast<double>(kSilenceFloor)));
    const double contrastDb = activeDb - gapDb;

    // Too little loud/quiet contrast: gating here would only expose separation
    // artefacts, so bypass entirely (or stay extra gentle near the boundary).
    if (contrastDb < kContrastBypassDb) return;
    const double rangeDb = contrastDb < kContrastHalfRangeDb ? params.rangeDb * 0.5 : params.rangeDb;

    const double thresholdDb = activeDb - params.thresholdBelowDb;
    applyExpander(buffer, sampleRate, thresholdDb, params, rangeDb);
}

// Transient designer: emphasises the leading edge of each hit. A fast and a slow
// envelope follow the cross-channel detector; where the fast envelope outruns the
// slow one (an onset) a short positive gain is applied, scaled by how far ahead it
// is. On sustained or steady material the two envelopes converge, so the gain
// returns to unity and the timbre is left untouched. One shared gain per sample is
// applied to every channel to preserve the stereo image.
void applyTransientDesigner(juce::AudioBuffer<float>& buffer, double sampleRate, double boostDb) noexcept
{
    if (! (boostDb > 0.0)) return;
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;

    const double fastAtk = std::exp(-1.0 / (0.5 * 0.001 * fs));   // 0.5 ms attack
    const double fastRel = std::exp(-1.0 / (30.0 * 0.001 * fs));  // 30 ms release
    const double slowAtk = std::exp(-1.0 / (18.0 * 0.001 * fs));  // 18 ms attack (lags onsets)
    const double slowRel = std::exp(-1.0 / (180.0 * 0.001 * fs)); // 180 ms release

    const int numCh = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();

    double fastEnv = sampleDetector(buffer, 0);
    double slowEnv = fastEnv;

    for (int i = 0; i < numSamples; ++i)
    {
        const double d = sampleDetector(buffer, i);
        fastEnv = d > fastEnv ? fastAtk * fastEnv + (1.0 - fastAtk) * d
                              : fastRel * fastEnv + (1.0 - fastRel) * d;
        slowEnv = d > slowEnv ? slowAtk * slowEnv + (1.0 - slowAtk) * d
                              : slowRel * slowEnv + (1.0 - slowRel) * d;

        // How far the fast envelope leads the slow one: 0 at steady state, up to 1
        // when the fast envelope reaches twice the slow one.
        const double lead = std::clamp(fastEnv / (slowEnv + 1.0e-9) - 1.0, 0.0, 1.0);
        const float gain = static_cast<float>(std::pow(10.0, (boostDb * lead) / 20.0));

        for (int ch = 0; ch < numCh; ++ch)
            buffer.getWritePointer(ch)[i] *= gain;
    }
}

// Soft-knee peak safety is shared via enhancer_dsp::softLimitInPlace.

} // namespace

DrumEnhanceStrength drumEnhanceStrengthFromString(const juce::String& text) noexcept
{
    const auto t = text.trim().toLowerCase();
    if (t == "light") return DrumEnhanceStrength::Light;
    if (t == "strong") return DrumEnhanceStrength::Strong;
    return DrumEnhanceStrength::Medium;
}

const char* drumEnhanceStrengthToString(DrumEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case DrumEnhanceStrength::Light: return "light";
        case DrumEnhanceStrength::Strong: return "strong";
        case DrumEnhanceStrength::Medium:
        default: return "medium";
    }
}

void DrumEnhancer::process(juce::AudioBuffer<float>& buffer, double sampleRate,
                           const DrumEnhanceOptions& options)
{
    if (! options.enabled) return;
    if (buffer.getNumChannels() <= 0 || buffer.getNumSamples() <= 0) return;
    if (! (sampleRate > 0.0) || ! std::isfinite(sampleRate)) return;

    const juce::ScopedNoDenormals noDenormals;
    StrengthParams params = paramsFor(options.strength);
    double transientBoostDb = transientBoostDbFor(options.strength);
    // A clean RoFormer drum stem needs little cleanup and far less punch: halve
    // the expander reach (it mostly self-bypasses anyway) and the transient boost
    // so the kit stays natural instead of being over-shaped.
    if (options.cleanModel)
    {
        params.ratio = 1.0 + (params.ratio - 1.0) * 0.5;
        params.rangeDb *= 0.5;
        transientBoostDb *= 0.4;
    }

    sanitiseInPlace(buffer);
    applyHighPass(buffer, sampleRate, params.highPassHz);

    // Cleanup first (may self-bypass on dense/continuous or silent material)...
    applyCleanupExpander(buffer, sampleRate, params);

    // ...then always shape the transients for punch, with a soft limiter so the
    // boosted onsets can never hard-clip. Both are no-ops on silence.
    applyTransientDesigner(buffer, sampleRate, transientBoostDb);
    softLimitInPlace(buffer);
}

} // namespace silverdaw
