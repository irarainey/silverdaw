#include "TestRegistry.h"

#include "VinylScratchProcessor.h"

#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

namespace silverdaw::tests
{
namespace
{
constexpr double kSampleRate = 48000.0;

VinylScratchProcessor::Settings immediateSettings()
{
    VinylScratchProcessor::Settings settings;
    settings.rateSmoothingSeconds = 0.0;
    settings.gainSmoothingSeconds = 0.0;
    settings.boundaryFadeSeconds = 0.0;
    return settings;
}

void fillRamp(juce::AudioBuffer<float>& buffer)
{
    for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            buffer.setSample(channel, sample, static_cast<float>(sample));
}

void testScratchNominalTurnTiming()
{
    requireNear(VinylScratchProcessor::secondsForTurns(1.0), 1.8, 1.0e-12,
                "one nominal platter turn should take 1.8 seconds");
    requireNear(VinylScratchProcessor::turnsForSeconds(1.8), 1.0, 1.0e-12,
                "1.8 seconds should advance one nominal platter turn");
}

void testScratchReadsForwardAndBackward()
{
    juce::AudioBuffer<float> source(1, 512);
    fillRamp(source);
    juce::AudioBuffer<float> output(1, 8);

    VinylScratchProcessor processor;
    processor.prepare(kSampleRate, immediateSettings());
    processor.reset(200.0, 1.0);
    processor.process(source, output, 0, output.getNumSamples());
    for (int sample = 0; sample < output.getNumSamples(); ++sample)
        requireNear(output.getSample(0, sample), 200.0 + sample, 1.0e-4,
                    "forward scratch should read ascending source positions");

    output.clear();
    processor.reset(200.0, -1.0);
    processor.process(source, output, 0, output.getNumSamples());
    for (int sample = 0; sample < output.getNumSamples(); ++sample)
        requireNear(output.getSample(0, sample), 200.0 - sample, 1.0e-4,
                    "reverse scratch should read descending source positions");
}

void testScratchClampsExtremeRate()
{
    auto settings = immediateSettings();
    settings.maxAbsRate = 4.0;

    VinylScratchProcessor processor;
    processor.prepare(kSampleRate, settings);
    processor.reset(1000.0);
    processor.setTargetRate(100.0);
    requireNear(processor.getTargetRate(), 4.0, 1.0e-12,
                "forward scratch rate should clamp to the configured limit");
    processor.setTargetRate(-100.0);
    requireNear(processor.getTargetRate(), -4.0, 1.0e-12,
                "reverse scratch rate should clamp to the configured limit");
}

void testScratchHoldFadesWithoutDiscontinuity()
{
    juce::AudioBuffer<float> source(1, 16384);
    source.clear();
    for (int sample = 0; sample < source.getNumSamples(); ++sample)
        source.setSample(0, sample, 0.75F);
    juce::AudioBuffer<float> output(1, 4096);

    VinylScratchProcessor processor;
    VinylScratchProcessor::Settings settings;
    settings.rateSmoothingSeconds = 0.003;
    settings.gainSmoothingSeconds = 0.0;
    settings.boundaryFadeSeconds = 0.0;
    processor.prepare(kSampleRate, settings);
    processor.reset(4096.0, 1.0);
    processor.setTargetRate(0.0);
    processor.process(source, output, 0, output.getNumSamples());

    float largestStep = 0.0F;
    for (int sample = 1; sample < output.getNumSamples(); ++sample)
    {
        largestStep = std::max(largestStep,
                               std::abs(output.getSample(0, sample)
                                        - output.getSample(0, sample - 1)));
        require(std::isfinite(output.getSample(0, sample)),
                "scratch hold should not produce non-finite samples");
    }
    require(largestStep < 0.05F, "scratch hold should fade without an abrupt step");
    require(std::abs(output.getSample(0, output.getNumSamples() - 1)) < 1.0e-4F,
            "stationary platter should settle to silence");
}

void testScratchBoundaryIsDeclicked()
{
    juce::AudioBuffer<float> source(1, 1024);
    for (int sample = 0; sample < source.getNumSamples(); ++sample)
        source.setSample(0, sample, 1.0F);
    juce::AudioBuffer<float> output(1, 256);

    auto settings = immediateSettings();
    settings.boundaryFadeSeconds = 0.002;
    VinylScratchProcessor processor;
    processor.prepare(kSampleRate, settings);
    processor.reset(64.0, -1.0);
    processor.process(source, output, 0, output.getNumSamples());

    float largestStep = 0.0F;
    for (int sample = 1; sample < output.getNumSamples(); ++sample)
        largestStep = std::max(largestStep,
                               std::abs(output.getSample(0, sample)
                                        - output.getSample(0, sample - 1)));
    require(largestStep < 0.05F, "source boundary should fade without a click");
    require(std::abs(output.getSample(0, output.getNumSamples() - 1)) < 1.0e-6F,
            "scratch movement beyond the source should be silent");
}

void testScratchSuppressesHighSpeedAliasing()
{
    constexpr int sourceSamples = 65536;
    const auto renderRms = [sourceSamples](double frequency, double rate)
    {
        juce::AudioBuffer<float> source(1, sourceSamples);
        for (int sample = 0; sample < sourceSamples; ++sample)
        {
            const double phase =
                2.0 * juce::MathConstants<double>::pi * frequency * sample / kSampleRate;
            source.setSample(0, sample, static_cast<float>(std::sin(phase)));
        }
        juce::AudioBuffer<float> output(1, 2048);
        auto settings = immediateSettings();
        settings.maxAbsRate = 8.0;
        VinylScratchProcessor processor;
        processor.prepare(kSampleRate, settings);
        processor.reset(sourceSamples / 2.0 + 0.25, rate);
        processor.process(source, output, 0, output.getNumSamples());

        double sumSquares = 0.0;
        for (int sample = 128; sample < output.getNumSamples(); ++sample)
        {
            const double value = output.getSample(0, sample);
            require(std::isfinite(value), "high-speed scratch should remain finite");
            sumSquares += value * value;
        }
        return std::sqrt(
            sumSquares / static_cast<double>(output.getNumSamples() - 128));
    };

    require(renderRms(18000.0, 1.0) > 0.6,
            "normal-speed scratch should retain high source frequencies");
    for (const auto [frequency, rate] :
         {std::pair{15000.0, 2.0}, std::pair{7000.0, 4.0},
          std::pair{3800.0, 8.0}})
    {
        require(renderRms(frequency, rate) < 0.08,
                "forward scratch should reject frequencies above its safe band");
        require(renderRms(frequency, -rate) < 0.08,
                "reverse scratch should reject frequencies above its safe band");
    }
}

void testScratchGainChangesAreSmoothed()
{
    juce::AudioBuffer<float> source(1, 8192);
    for (int sample = 0; sample < source.getNumSamples(); ++sample)
        source.setSample(0, sample, 1.0F);
    juce::AudioBuffer<float> output(1, 1024);

    VinylScratchProcessor processor;
    VinylScratchProcessor::Settings settings;
    settings.rateSmoothingSeconds = 0.0;
    settings.gainSmoothingSeconds = 0.003;
    settings.boundaryFadeSeconds = 0.0;
    processor.prepare(kSampleRate, settings);
    processor.reset(2048.0, 1.0, 1.0F);
    processor.setTargetGain(0.0F);
    processor.process(source, output, 0, output.getNumSamples());

    require(output.getSample(0, 0) > 0.9F,
            "crossfader smoothing should not jump to silence");
    require(output.getSample(0, output.getNumSamples() - 1) < 0.01F,
            "crossfader smoothing should settle near its target");
}

void testScratchDirectionChangeRemainsContinuous()
{
    juce::AudioBuffer<float> source(1, 32768);
    for (int sample = 0; sample < source.getNumSamples(); ++sample)
    {
        const double phase =
            2.0 * juce::MathConstants<double>::pi * 440.0 * sample / kSampleRate;
        source.setSample(0, sample, static_cast<float>(0.8 * std::sin(phase)));
    }
    juce::AudioBuffer<float> output(1, 4096);

    VinylScratchProcessor processor;
    VinylScratchProcessor::Settings settings;
    settings.rateSmoothingSeconds = 0.005;
    settings.gainSmoothingSeconds = 0.0;
    settings.boundaryFadeSeconds = 0.0;
    processor.prepare(kSampleRate, settings);
    processor.reset(16384.0, 4.0);
    processor.setTargetRate(-4.0);
    processor.process(source, output, 0, output.getNumSamples());

    float largestStep = 0.0F;
    for (int sample = 1; sample < output.getNumSamples(); ++sample)
    {
        const float value = output.getSample(0, sample);
        require(std::isfinite(value), "scratch reversal should remain finite");
        largestStep = std::max(largestStep,
                               std::abs(value - output.getSample(0, sample - 1)));
    }
    require(largestStep < 0.35F,
            "scratch reversal should not introduce an out-of-band discontinuity");
    require(processor.getCurrentRate() < -3.9,
            "scratch reversal should converge to the requested reverse rate");
}

void testScratchRejectsInvalidDestinationRange()
{
    juce::AudioBuffer<float> source(1, 128);
    juce::AudioBuffer<float> output(1, 16);
    output.clear();

    VinylScratchProcessor processor;
    processor.prepare(kSampleRate, immediateSettings());
    processor.reset(64.0, 1.0);
    processor.process(source, output, -1, 8);
    processor.process(source, output, output.getNumSamples(), 8);

    requireNear(processor.getSourcePosition(), 64.0, 1.0e-12,
                "invalid output ranges should not advance scratch state");
}

void testScratchClampsForwardBoundaryWithoutHiddenOvershoot()
{
    juce::AudioBuffer<float> source(1, 16);
    fillRamp(source);
    juce::AudioBuffer<float> output(1, 8);

    VinylScratchProcessor processor;
    processor.prepare(kSampleRate, immediateSettings());
    processor.reset(14.0, 2.0);
    processor.process(source, output, 0, output.getNumSamples());

    requireNear(processor.getSourcePosition(), 15.0, 1.0e-12,
                "forward scratch should clamp to the last source sample");
    require(output.getSample(0, output.getNumSamples() - 1) <= 15.0F,
            "forward boundary clamp should never read beyond the source");
}

void testScratchClampsReverseBoundaryAndAllowsReentry()
{
    juce::AudioBuffer<float> source(1, 64);
    fillRamp(source);
    juce::AudioBuffer<float> output(1, 8);

    VinylScratchProcessor processor;
    processor.prepare(kSampleRate, immediateSettings());
    processor.reset(0.0, -2.0);
    processor.process(source, output, 0, output.getNumSamples());

    requireNear(processor.getSourcePosition(), 0.0, 1.0e-12,
                "reverse scratch should clamp at the start boundary");

    processor.setTargetRate(2.0);
    output.clear();
    processor.process(source, output, 0, output.getNumSamples());
    require(processor.getSourcePosition() > 0.0,
            "forward re-entry should resume immediately from the start boundary");
}
} // namespace

void addScratchDspTests(std::vector<TestCase>& tests)
{
    tests.push_back({"scratch DSP uses 33rpm turn timing", testScratchNominalTurnTiming});
    tests.push_back({"scratch DSP reads forward and backward", testScratchReadsForwardAndBackward});
    tests.push_back({"scratch DSP clamps extreme rate", testScratchClampsExtremeRate});
    tests.push_back({"scratch DSP fades a platter hold", testScratchHoldFadesWithoutDiscontinuity});
    tests.push_back({"scratch DSP declicks source boundaries", testScratchBoundaryIsDeclicked});
    tests.push_back({"scratch DSP suppresses high-speed aliasing", testScratchSuppressesHighSpeedAliasing});
    tests.push_back({"scratch DSP smooths crossfader gain", testScratchGainChangesAreSmoothed});
    tests.push_back({"scratch DSP smooths direction changes", testScratchDirectionChangeRemainsContinuous});
    tests.push_back({"scratch DSP rejects invalid output ranges", testScratchRejectsInvalidDestinationRange});
    tests.push_back({"scratch DSP clamps forward boundary without overshoot", testScratchClampsForwardBoundaryWithoutHiddenOvershoot});
    tests.push_back({"scratch DSP clamps reverse boundary and allows reentry", testScratchClampsReverseBoundaryAndAllowsReentry});
}

} // namespace silverdaw::tests
