#pragma once

#include "MasterClockSource.h"
#include "Metronome.h"
#include "OutputKeepAlive.h"
#include "SafetyLimiter.h"

#include <atomic>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Apply master gain before metering and inject keep-alive after gain so the endpoint floor is
// volume-independent. The metronome click is also mixed post-gain so the project master volume
// never silences the monitoring tick — which means the click bypasses the plugin delay
// compensation delay lines, so it has to offset its own position to stay with the music
// (see `setMetronomeLeadSource`).
class MeteringSource : public juce::AudioSource
{
  public:
    MeteringSource(juce::AudioSource& s, OutputKeepAlive& keepAlive, MasterClockSource& clock,
                   Metronome& metronome)
        : source(s), keepAlive(keepAlive), clock(clock), metronome(metronome) {}

    /** Point the click at the PDC alignment (`BusGraph::latencyCompensationAtomicRef()`), which
     *  the audio thread then reads live. The transport's render cursor deliberately leads the
     *  audible output by this many samples — `AudioEngine::primePluginPipeline` pre-rolls the
     *  graph and advances the transport by the alignment — so a click rendered against the raw
     *  cursor would lead the music by it too, and a performer following the click would play
     *  early. Left null (lead 0) the click is rendered against the raw cursor, which is exactly
     *  right when nothing adds latency. */
    void setMetronomeLeadSource(const std::atomic<int>* leadSamples) noexcept
    {
        metronomeLead = leadSamples;
    }

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
    {
        source.prepareToPlay(samplesPerBlockExpected, sampleRate);
        keepAlive.prepare(sampleRate);
        metronome.prepare(sampleRate);
        // The output device is now streaming: hold the endpoint awake from this first block so a
        // freshly-opened or reconnected DAC never sleeps before the user loads a project and plays.
        keepAlive.setDeviceActive(true);
        smoothedGain.reset(sampleRate, 0.01);
        smoothedGain.setCurrentAndTargetValue(targetGain.load(std::memory_order_relaxed));
        limiter.prepare(sampleRate);
    }

    void releaseResources() override
    {
        keepAlive.setDeviceActive(false);
        limiter.reset();
        source.releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        // ScopedNoDenormals protects realtime DSP from denormal CPU spikes.
        const juce::ScopedNoDenormals scopedNoDenormals;
        // Capture the transport position BEFORE pulling the source: the clock advances inside the
        // pull, so this is the true start-of-block sample.
        const juce::int64 posBefore = clock.getPositionSamples();
        source.getNextAudioBlock(info);
        if (info.buffer == nullptr || info.numSamples <= 0)
            return;

        const int n = info.numSamples;
        const int numCh = info.buffer->getNumChannels();

        float programPeak = 0.0F;
        for (int ch = 0; ch < numCh; ++ch)
            programPeak = juce::jmax(programPeak, info.buffer->getMagnitude(ch, info.startSample, n));

        smoothedGain.setTargetValue(targetGain.load(std::memory_order_relaxed));
        const float startGain = smoothedGain.getNextValue();
        if (n > 1)
            smoothedGain.skip(n - 1);
        const float endGain = smoothedGain.getCurrentValue();

        const bool unity = std::abs(startGain - 1.0F) < 1.0e-6F &&
                           std::abs(endGain - 1.0F) < 1.0e-6F;
        if (! unity)
        {
            for (int ch = 0; ch < numCh; ++ch)
                info.buffer->applyGainRamp(ch, info.startSample, n, startGain, endGain);
        }

        // Mix the metronome click post master gain. A recording count-in owns the click while it
        // runs: the transport is deliberately parked, so the click is driven by the count-in's own
        // counter rather than the playhead (and needs no PDC offset, as nothing is playing to be
        // out of step with). Otherwise the click only sounds when the transport actually advanced
        // this block (real playback — not a stopped block or a wake pre-roll, where the position is
        // frozen), which keeps it phase-aligned to the playhead and seek-correct.
        const juce::int64 countIn = countInRemaining.load(std::memory_order_acquire);
        if (countIn > 0)
        {
            const juce::int64 pos = countInPos.load(std::memory_order_relaxed);
            metronome.render(*info.buffer, info.startSample, n, pos, clock.getSampleRate());
            countInPos.store(pos + n, std::memory_order_relaxed);
            countInRemaining.store(juce::jmax(juce::int64{0}, countIn - n), std::memory_order_release);
        }
        else if (clock.getPositionSamples() == posBefore + static_cast<juce::int64>(n))
        {
            // Step back by the PDC alignment so the click sounds with the arrangement content the
            // listener is actually hearing, not with the render cursor that leads it (ADR 0026). A
            // plugin added mid-playback moves the alignment, which shifts the click by the delta
            // for one block — the compensation delay lines are being resized in the same moment, so
            // the mix itself is discontinuous there too, and both settle on the next block.
            const juce::int64 lead =
                metronomeLead != nullptr
                    ? static_cast<juce::int64>(metronomeLead->load(std::memory_order_relaxed))
                    : 0;
            // A negative position simply yields no clicks: with an alignment in play the beats
            // before the start of the timeline are not audible yet.
            metronome.render(*info.buffer, info.startSample, n, posBefore - lead,
                             clock.getSampleRate());
        }

        limiter.process(*info.buffer, info.startSample, n);

        if (numCh > 0)
            atomicMaxFloat(peakL_, info.buffer->getMagnitude(0, info.startSample, n));
        if (numCh > 1)
            atomicMaxFloat(peakR_, info.buffer->getMagnitude(1, info.startSample, n));
        else if (numCh > 0)
            atomicMaxFloat(peakR_, info.buffer->getMagnitude(0, info.startSample, n));

        keepAlive.maybeApplyFloor(*info.buffer, info.startSample, n, programPeak);
    }

    void setTargetGain(float g) noexcept
    {
        targetGain.store(juce::jlimit(0.0F, 1.0F, g), std::memory_order_relaxed);
    }

    void setSafetyLimiterEnabled(bool enabled, bool snap) noexcept
    {
        limiter.setEnabled(enabled, snap);
    }

    void consumePeaks(float& outL, float& outR) noexcept
    {
        outL = peakL_.exchange(0.0F, std::memory_order_relaxed);
        outR = peakR_.exchange(0.0F, std::memory_order_relaxed);
    }

    // Recording count-in: click for `beats` at `bpm` with the transport parked, so the performer
    // is counted in *to* the anchor instead of being carried past it. The click cannot ride the
    // transport here (it is stopped, and the whole point is that it stays stopped), so it runs
    // off this own free-running counter, phase-locked to beat 0 of the count-in.
    void beginCountIn(double beats, double bpm) noexcept
    {
        const double sampleRate = clock.getSampleRate();
        if (beats <= 0.0 || bpm <= 0.0 || sampleRate <= 0.0)
        {
            cancelCountIn();
            return;
        }
        countInPos.store(0, std::memory_order_relaxed);
        countInRemaining.store(static_cast<juce::int64>(beats * (60.0 / bpm) * sampleRate),
                               std::memory_order_release);
    }

    void cancelCountIn() noexcept { countInRemaining.store(0, std::memory_order_release); }

    bool isCountInActive() const noexcept
    {
        return countInRemaining.load(std::memory_order_acquire) > 0;
    }

    double getCountInRemainingMs() const noexcept
    {
        const double sampleRate = clock.getSampleRate();
        if (sampleRate <= 0.0) return 0.0;
        return static_cast<double>(countInRemaining.load(std::memory_order_acquire)) * 1000.0
               / sampleRate;
    }

  private:
    static void atomicMaxFloat(std::atomic<float>& a, float v) noexcept
    {
        float cur = a.load(std::memory_order_relaxed);
        while (v > cur && ! a.compare_exchange_weak(cur, v, std::memory_order_relaxed))
        {
        }
    }

    juce::AudioSource& source;
    OutputKeepAlive& keepAlive;
    MasterClockSource& clock;
    Metronome& metronome;
    // Live PDC alignment, owned by BusGraph; null until wired (and in tests), meaning no lead.
    const std::atomic<int>* metronomeLead{nullptr};
    juce::LinearSmoothedValue<float> smoothedGain;
    SafetyLimiter limiter;
    std::atomic<float> targetGain{1.0F};
    std::atomic<float> peakL_{0.0F};
    std::atomic<float> peakR_{0.0F};
    // Recording count-in click: samples left to click for, and the click's own play position.
    // Written from the message thread only while the count-in is not running.
    std::atomic<juce::int64> countInRemaining{0};
    std::atomic<juce::int64> countInPos{0};
};

} // namespace silverdaw
