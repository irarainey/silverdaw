// Warp: time-stretch correctness and timeline duration mapping.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "EdgeFadeSnapshot.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MixdownEngine.h"
#include "OffsetSource.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "SharedFx.h"
#include "ToneEq.h"
#include "ValueTreeJson.h"
#include "WarpProcessor.h"

#include <atomic>
#include <array>
#include <chrono>
#include <cmath>
#include <exception>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#include <juce_events/juce_events.h>

namespace silverdaw::tests
{
namespace
{

// ConstantSource reports an endless stream; a real clip's reader has a finite length, which
// is what the timeline-length mapping has to scale.
class FiniteConstantSource : public ConstantSource
{
  public:
    FiniteConstantSource(float v, juce::int64 lengthSamples)
        : ConstantSource(v), length(lengthSamples) {}
    juce::int64 getTotalLength() const override { return length; }

  private:
    juce::int64 length;
};

void testWarpProcessorBasicStretch()
{
    // Smoke test: build a WarpProcessor, feed it a unit-amplitude sine
    // wave at native rate, and verify it produces samples that look
    // like audio (non-zero, finite, within range). This is enough to
    // confirm the Rubber Band integration actually links and runs;
    // detailed correctness tests (steady-state ratio, seek handling,
    // pitch independence) belong in the next pass.
    constexpr double kSampleRate = 48000.0;
    constexpr int kChannels = 2;
    constexpr int kBlockSamples = 512;
    silverdaw::WarpProcessor warp(kChannels, kSampleRate,
                                   RubberBand::RubberBandStretcher::OptionEngineFaster);
    warp.prepareToPlay(kBlockSamples);
    warp.setTempoRatio(1.25); // play 25 % faster
    warp.setPitchScale(1.0);

    std::vector<std::vector<float>> outBuffers(kChannels, std::vector<float>(kBlockSamples, 0.0f));
    std::vector<float*> outPtrs(kChannels);
    for (int c = 0; c < kChannels; ++c) outPtrs[c] = outBuffers[c].data();

    // Source-read callback feeds a 440 Hz sine wave at the requested
    // source position. Phase computed from the absolute sample index so
    // it stays continuous across blocks.
    auto readSource = [&](float* const* dest, juce::int64 sourcePos, int n)
    {
        for (int c = 0; c < kChannels; ++c)
        {
            for (int i = 0; i < n; ++i)
            {
                const double phase = 2.0 * juce::MathConstants<double>::pi * 440.0
                                     * static_cast<double>(sourcePos + i) / kSampleRate;
                dest[c][i] = static_cast<float>(std::sin(phase) * 0.5);
            }
        }
    };

    // Run a few blocks so the stretcher's start-pad + steady-state
    // ramp has time to produce real output.
    int totalProduced = 0;
    bool sawNonZero = false;
    for (int block = 0; block < 8; ++block)
    {
        const int produced = warp.process(outPtrs.data(), kBlockSamples, readSource);
        totalProduced += produced;
        for (int c = 0; c < kChannels; ++c)
        {
            for (int i = 0; i < produced; ++i)
            {
                const float v = outBuffers[c][i];
                require(std::isfinite(v), "warp produced non-finite sample");
                require(std::abs(v) <= 1.5f, "warp produced wildly out-of-range sample");
                if (std::abs(v) > 1e-4f) sawNonZero = true;
            }
        }
    }
    require(sawNonZero, "warp produced no audible output across 8 blocks");

    // Device reconfiguration may increase the host block size after audio has
    // already passed through Rubber Band. Preparing again must remain valid.
    warp.prepareToPlay(8192);
    const int producedAfterReprepare =
        warp.process(outPtrs.data(), kBlockSamples, readSource);
    require(producedAfterReprepare == kBlockSamples,
            "warp must keep producing after a larger re-prepare");
}

void testWarpTimelineDurationMapping()
{
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, 1.0) == 4000,
            "unwarped duration should remain in source samples");

    silverdaw::WarpProcessor faster(2, 48000.0, RubberBand::RubberBandStretcher::OptionEngineFaster);
    faster.prepareToPlay(512);
    faster.setTempoRatio(2.0);
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, faster.getTempoRatio()) == 2000,
            "2x tempo ratio should halve visible timeline duration");

    silverdaw::WarpProcessor slower(2, 48000.0, RubberBand::RubberBandStretcher::OptionEngineFaster);
    slower.prepareToPlay(512);
    slower.setTempoRatio(0.5);
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, slower.getTempoRatio()) == 8000,
            "0.5x tempo ratio should double visible timeline duration");
}

void testWarpPitchStrategy()
{
    using Stretcher = RubberBand::RubberBandStretcher;
    constexpr auto transientsMask = Stretcher::OptionTransientsCrisp
                                    | Stretcher::OptionTransientsMixed
                                    | Stretcher::OptionTransientsSmooth;

    const auto tempoOnly = silverdaw::WarpProcessor::realtimeOptionsFor(
        Stretcher::OptionEngineFaster | Stretcher::OptionTransientsCrisp, 1.0);
    require((tempoOnly & Stretcher::OptionProcessRealTime) != 0,
            "warp playback must use Rubber Band real-time mode");
    require((tempoOnly & Stretcher::OptionPitchHighConsistency) == 0,
            "tempo-only warp should use Rubber Band's lower-cost pitch strategy");
    require((tempoOnly & Stretcher::OptionPitchHighQuality) == 0,
            "tempo-only warp does not pitch shift, so it needs no pitch-quality option");
    require((tempoOnly & transientsMask) == Stretcher::OptionTransientsCrisp,
            "tempo-only warp must keep crisp transients so time-stretched drums stay sharp");

    // A pitch shift resamples, and crisp phase resets then fire on sustained tones
    // as well as real transients. Mixed protects musical fundamentals while still
    // resetting outside that range, so percussive attacks survive.
    const auto pitchShifted = silverdaw::WarpProcessor::realtimeOptionsFor(
        Stretcher::OptionEngineFaster | Stretcher::OptionTransientsCrisp, 1.25);
    require((pitchShifted & transientsMask) == Stretcher::OptionTransientsMixed,
            "a pitch-shifted R2 warp must not reset phases on musical fundamentals");
    require((pitchShifted & Stretcher::OptionPitchHighQuality) != 0,
            "a pitch shift fixed at construction should use the high-quality pitch method");
    require((pitchShifted & Stretcher::OptionPitchHighConsistency) == 0,
            "high consistency is for live pitch changes and is escalated to on demand");

    // A mode that already states its transient handling keeps it.
    const auto tonalShifted = silverdaw::WarpProcessor::realtimeOptionsFor(
        Stretcher::OptionEngineFaster | Stretcher::OptionTransientsSmooth
            | Stretcher::OptionWindowLong,
        1.25);
    require((tonalShifted & transientsMask) == Stretcher::OptionTransientsSmooth,
            "an explicit transient choice must survive the pitch-shift adjustment");

    const auto finerAtUnity = silverdaw::WarpProcessor::realtimeOptionsFor(
        Stretcher::OptionEngineFiner, 1.0);
    require((finerAtUnity & Stretcher::OptionPitchHighConsistency) != 0,
            "finer warp must configure immutable dynamic-pitch consistency at construction");

    // R3 refuses setPitchOption after construction, so it cannot use the
    // escalate-on-live-change route and keeps high consistency throughout.
    const auto finerShifted = silverdaw::WarpProcessor::realtimeOptionsFor(
        Stretcher::OptionEngineFiner, 1.25);
    require((finerShifted & Stretcher::OptionPitchHighConsistency) != 0,
            "finer warp must keep dynamic-pitch consistency when pitch shifting");
    require((finerShifted & Stretcher::OptionPitchHighQuality) == 0,
            "finer warp must not combine two pitch methods");
}

void testWarpFeedsRubberBandOnDemand()
{
    constexpr int kBlockSamples = 512;
    silverdaw::WarpProcessor warp(
        1, 48000.0, RubberBand::RubberBandStretcher::OptionEngineFaster);
    warp.prepareToPlay(kBlockSamples);
    warp.setTempoRatio(1.0);

    std::array<float, kBlockSamples> output{};
    float* outputPtr = output.data();
    std::vector<int> sourceRequests;
    const auto readSource =
        [&](float* const* dest, juce::int64, int numSamples)
    {
        sourceRequests.push_back(numSamples);
        std::fill(dest[0], dest[0] + numSamples, 0.25F);
    };

    for (int block = 0; block < 4; ++block)
        warp.process(&outputPtr, kBlockSamples, readSource);

    require(!sourceRequests.empty(), "warp should request source audio");
    require(std::all_of(sourceRequests.begin(), sourceRequests.end(),
                        [](int samples) { return samples > 0 && samples <= 1024; }),
            "warp source requests must remain within prepared feed capacity");
    require(std::any_of(sourceRequests.begin(), sourceRequests.end(),
                        [](int samples) { return samples < 1024; }),
            "warp should honour Rubber Band source demand instead of always overfeeding");
}

void testWarpProducesAtExtremeRatios()
{
    constexpr int kBlockSamples = 512;
    silverdaw::WarpProcessor warp(
        1, 96000.0, RubberBand::RubberBandStretcher::OptionEngineFiner, 0.25);
    warp.prepareToPlay(kBlockSamples);
    warp.setTempoRatio(4.0);

    std::array<float, kBlockSamples> output{};
    float* outputPtr = output.data();
    bool sawAudio = false;
    const auto readSource =
        [](float* const* dest, juce::int64 sourcePos, int numSamples)
    {
        for (int i = 0; i < numSamples; ++i)
        {
            const double phase =
                2.0 * juce::MathConstants<double>::pi * 440.0
                * static_cast<double>(sourcePos + i) / 96000.0;
            dest[0][i] = static_cast<float>(std::sin(phase) * 0.5);
        }
    };

    for (int block = 0; block < 8; ++block)
    {
        const int produced = warp.process(&outputPtr, kBlockSamples, readSource);
        require(produced == kBlockSamples,
                "extreme legal warp ratios must satisfy the output block contract");
        sawAudio = sawAudio
            || std::any_of(output.begin(), output.end(),
                           [](float sample) { return std::abs(sample) > 1.0e-4F; });
    }
    require(sawAudio, "extreme legal warp ratios must not reset into permanent silence");
}

void testOffsetSourceChunksOversizedWarpRequests()
{
    constexpr double sampleRate = 48000.0;
    constexpr int preparedBlock = 256;
    constexpr int requestedSamples = 10000;

    for (const double ratio : {0.25, 1.25, 4.0})
    {
        ConstantSource child(0.25F);
        silverdaw::WarpProcessor warp(
            1, sampleRate, RubberBand::RubberBandStretcher::OptionEngineFaster);
        warp.setTempoRatio(ratio);
        warp.setPitchScale(1.0);

        silverdaw::OffsetSource source(&child);
        source.setOffsetSamples(0);
        source.setInSourceSamples(0);
        source.setClipDurationSamples(50000);
        source.setWarpProcessor(&warp);
        source.prepareToPlay(preparedBlock, sampleRate);

        juce::AudioBuffer<float> output(2, requestedSamples);
        output.clear();
        juce::AudioSourceChannelInfo info(&output, 0, requestedSamples);
        source.getNextAudioBlock(info);

        bool sawAudio = false;
        int silentRun = 0;
        int longestSilentRun = 0;
        for (int ch = 0; ch < output.getNumChannels(); ++ch)
        {
            silentRun = 0;
            for (int i = 0; i < requestedSamples; ++i)
            {
                const float sample = output.getSample(ch, i);
                require(std::isfinite(sample), "oversized warped read must stay finite");
                if (std::abs(sample) > 1.0e-4F)
                {
                    sawAudio = true;
                    silentRun = 0;
                }
                else
                {
                    longestSilentRun = juce::jmax(longestSilentRun, ++silentRun);
                }
            }
        }
        require(sawAudio, "oversized warped read must produce audio across scratch chunks");
        require(longestSilentRun < preparedBlock,
                "oversized warped read must not insert a silent seam between chunks");
    }

    silverdaw::WarpProcessor boundedChannels(
        32, sampleRate, RubberBand::RubberBandStretcher::OptionEngineFaster);
    require(boundedChannels.getNumChannels() == silverdaw::WarpProcessor::kMaxChannels,
            "warp channel count must stay within the preallocated pointer capacity");

    ConstantSource unclippedChild(0.25F);
    silverdaw::WarpProcessor clippedWarp(
        1, sampleRate, RubberBand::RubberBandStretcher::OptionEngineFaster);
    clippedWarp.setPitchScale(1.1);
    silverdaw::OffsetSource clippedSource(&unclippedChild);
    clippedSource.setOffsetSamples(0);
    clippedSource.setInSourceSamples(100);
    clippedSource.setClipDurationSamples(512);
    clippedSource.setWarpProcessor(&clippedWarp);
    clippedSource.prepareToPlay(preparedBlock, sampleRate);

    juce::AudioBuffer<float> clippedOutput(1, 5000);
    juce::AudioSourceChannelInfo clippedInfo(&clippedOutput, 0, clippedOutput.getNumSamples());
    clippedSource.getNextAudioBlock(clippedInfo);
    require(clippedOutput.getMagnitude(0, 4000, 1000) < 1.0e-4F,
            "warped reads must not leak source audio beyond the trimmed clip window");
}

// A clip window may start BEFORE the source file: sliding a clip's beat grid onto the beat
// re-cuts the window without moving the clip, which can push the in-point negative. The
// overhang must render as silence, and — critically — the child must never be asked for a
// negative read position, which would read garbage or assert.
void testOffsetSourceSilencesWindowOverhangingSourceStart()
{
    constexpr int kOverhang = 4800; // 100 ms of silence before the file starts
    constexpr int kTotal = 48000;

    RampSource child; // each sample's value IS its source position
    silverdaw::OffsetSource source(&child);
    source.setOffsetSamples(0);
    source.setInSourceSamples(-kOverhang);
    source.setClipDurationSamples(kTotal);
    require(source.getInSourceSamples() == -kOverhang,
            "a negative in-point must survive the setter rather than being clamped to zero");
    source.prepareToPlay(kTotal, 48000.0);

    juce::AudioBuffer<float> out(1, kTotal);
    out.clear();
    juce::AudioSourceChannelInfo info(&out, 0, kTotal);
    source.getNextAudioBlock(info);

    // Past the clip's edge fade, but still before the file: must be true silence, not a
    // faded copy of the source's first sample.
    for (int i = 1000; i < kOverhang; ++i)
        requireNear(static_cast<double>(out.getSample(0, i)), 0.0, 1.0e-6,
                    "the head that falls before the file must be silent");
    // Well inside the clip, away from both edge fades, the source plays normally and in
    // order from its very first sample.
    for (int i = 10000; i < 20000; ++i)
        requireNear(static_cast<double>(out.getSample(0, i)), static_cast<double>(i - kOverhang),
                    1.0e-6, "audio after the overhang must be the source read from sample zero");
}

// A stretched clip must remain audible for its whole timeline window. The clip's timeline
// extent scales with the warp ratio, but juce::AudioTransportSource ends the stream at
// `getNextReadPosition() >= getTotalLength()`, so an unwarped total length made a stretched
// clip fall silent at its unstretched end while still being drawn (and rendered) full length.
void testOffsetSourceTotalLengthFollowsWarpedTimeline()
{
    constexpr double sampleRate = 48000.0;
    constexpr juce::int64 sourceLength = 96000;
    constexpr juce::int64 offset = 24000;

    FiniteConstantSource child(0.25F, sourceLength);
    silverdaw::OffsetSource source(&child);
    source.setOffsetSamples(offset);
    source.setInSourceSamples(0);
    source.setClipDurationSamples(sourceLength);

    require(source.getTotalLength() == sourceLength + offset,
            "an unwarped clip must report its plain source length on the timeline");

    silverdaw::WarpProcessor warp(
        1, sampleRate, RubberBand::RubberBandStretcher::OptionEngineFaster);
    source.setWarpProcessor(&warp);

    // tempoRatio = project/source, so 0.5 halves the tempo and doubles the timeline extent.
    warp.setTempoRatio(0.5);
    const juce::int64 stretched = source.getTotalLength();
    require(stretched > sourceLength + offset,
            "stretching a clip must extend the length the transport plays to, not just its tempo");
    require(stretched == offset + silverdaw::WarpProcessor::timelineSamplesForSourceSamples(
                                      sourceLength, 0.5),
            "warped total length must match the timeline mapping the clip window uses");

    // The transport must never declare EOF before the clip's own audible end.
    const juce::int64 clipEnd =
        offset + silverdaw::WarpProcessor::timelineSamplesForSourceSamples(
                     source.getClipDurationSamples(), 0.5);
    require(stretched >= clipEnd,
            "reported length must cover the clip window or the transport stops mid-clip");

    // Compressing (ratio > 1) shortens the timeline extent and must not be over-reported.
    warp.setTempoRatio(2.0);
    require(source.getTotalLength() < sourceLength + offset,
            "compressing a clip must shorten the length the transport plays to");

    // A bypassed warp is inactive, so the timeline mapping is identity again.
    warp.setTempoRatio(1.0);
    require(source.getTotalLength() == sourceLength + offset,
            "a bypassed warp must leave the reported length unscaled");
}

void testWarpReportsThroughputDiagnostics()
{
    constexpr int kBlockSamples = 512;
    silverdaw::WarpProcessor warp(
        1, 48000.0, RubberBand::RubberBandStretcher::OptionEngineFaster);
    warp.prepareToPlay(kBlockSamples);
    warp.setTempoRatio(1.0);

    require(warp.getShortfallCount() == 0, "a fresh warp must report no shortfalls");
    require(warp.getRealtimeFactor() == 0.0,
            "a warp that has produced nothing must report no throughput");

    std::array<float, kBlockSamples> output{};
    float* outputPtr = output.data();
    const auto readSource =
        [](float* const* dest, juce::int64, int numSamples)
    { std::fill(dest[0], dest[0] + numSamples, 0.25F); };

    for (int block = 0; block < 32; ++block)
        warp.process(&outputPtr, kBlockSamples, readSource);

    require(warp.getRealtimeFactor() > 0.0,
            "a warp that has produced audio must report a real-time factor");
    // Priming costs the opening blocks, so only steady-state throughput is asserted here.
    // The shortfall counter is what distinguishes a starved run from a merely slow one.
    require(warp.getShortfallCount() < 32,
            "shortfalls must be counted per unfilled block, not per processed block");
}

// A warp is usually enabled before any pitch is dialled in, and a pitch change deliberately
// does not rebuild the stretcher. The offline render always builds with the final pitch, so
// anything the constructor decides from the pitch has to be revisited live or playback and
// export drift apart. This pins that they agree.
void testWarpLivePitchChangeMatchesRenderPath()
{
    constexpr int kBlockSamples = 512;
    constexpr double kSampleRate = 48000.0;
    constexpr double kToneHz = 440.0;
    const double pitchScale = silverdaw::warpPitchScale(5.0, 0.0);
    const double expectedHz = kToneHz * pitchScale;

    // Share of the output energy still on the intended shifted tone. A clean shift of a pure
    // sine keeps nearly all of it there; phase resets at falsely detected onsets scatter it.
    const auto tonalPurity = [](const std::vector<float>& signal, double hz, double rate)
    {
        double re = 0.0;
        double im = 0.0;
        double total = 0.0;
        const double w = 2.0 * juce::MathConstants<double>::pi * hz / rate;
        for (size_t i = 0; i < signal.size(); ++i)
        {
            const double s = static_cast<double>(signal[i]);
            re += s * std::cos(w * static_cast<double>(i));
            im += s * std::sin(w * static_cast<double>(i));
            total += s * s;
        }
        if (total <= 0.0) return 0.0;
        const double binEnergy = 2.0 * (re * re + im * im) / static_cast<double>(signal.size());
        return juce::jlimit(0.0, 1.0, binEnergy / total);
    };

    const auto capture = [&](double constructionPitch, bool changeLive)
    {
        silverdaw::WarpProcessor warp(1, kSampleRate, silverdaw::parseWarpMode("rhythmic"),
                                      constructionPitch);
        warp.prepareToPlay(kBlockSamples);
        warp.setTempoRatio(1.0);
        if (changeLive) warp.setPitchScale(pitchScale);

        std::vector<float> block(static_cast<size_t>(kBlockSamples), 0.0f);
        float* blockPtr = block.data();
        const auto readSource =
            [toneHz = kToneHz, rate = kSampleRate](float* const* dest, juce::int64 sourcePos,
                                                   int numSamples)
        {
            for (int i = 0; i < numSamples; ++i)
                dest[0][i] = 0.5f
                           * static_cast<float>(std::sin(
                                 2.0 * juce::MathConstants<double>::pi * toneHz
                                 * static_cast<double>(sourcePos + i) / rate));
        };

        std::vector<float> captured;
        const int blocks = static_cast<int>(kSampleRate) * 4 / kBlockSamples;
        for (int b = 0; b < blocks; ++b)
        {
            warp.process(&blockPtr, kBlockSamples, readSource);
            if (b >= 8) captured.insert(captured.end(), block.begin(), block.end());
        }
        return captured;
    };

    const double renderPurity = tonalPurity(capture(pitchScale, false), expectedHz, kSampleRate);
    const double livePurity = tonalPurity(capture(1.0, true), expectedHz, kSampleRate);

    require(renderPurity > 0.9,
            "a pitch supplied at construction must shift a pure tone cleanly");
    require(livePurity > 0.9,
            "a pitch applied after construction must shift a pure tone just as cleanly");
    require(std::abs(renderPurity - livePurity) < 0.05,
            "live pitch playback must not diverge in quality from the render path");
}

} // namespace

void addWarpTests(std::vector<TestCase>& tests)
{
    tests.push_back({"WarpProcessor basic real-time stretch", testWarpProcessorBasicStretch});
    tests.push_back({"Warp timeline duration mapping", testWarpTimelineDurationMapping});
    tests.push_back({"Warp pitch strategy", testWarpPitchStrategy});
    tests.push_back({"Warp feeds Rubber Band on demand", testWarpFeedsRubberBandOnDemand});
    tests.push_back({"Warp produces at extreme ratios", testWarpProducesAtExtremeRatios});
    tests.push_back({"Warp reports throughput diagnostics", testWarpReportsThroughputDiagnostics});
    tests.push_back({"Warp live pitch change matches the render path", testWarpLivePitchChangeMatchesRenderPath});
    tests.push_back({"OffsetSource chunks oversized warp requests", testOffsetSourceChunksOversizedWarpRequests});

    tests.push_back({"OffsetSource silences a window overhanging the start of the source", testOffsetSourceSilencesWindowOverhangingSourceStart});
    tests.push_back({"OffsetSource total length follows the warped timeline", testOffsetSourceTotalLengthFollowsWarpedTimeline});
}

} // namespace silverdaw::tests
