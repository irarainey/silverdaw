#pragma once

#include "Metronome.h"

#include <atomic>
#include <cmath>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_utils/juce_audio_utils.h>

namespace silverdaw
{

// Wraps the Clip Editor's preview transport and mixes a metronome click aligned to the clip's own
// beat grid (the source BPM + phase anchor shown in the editor), independent of the main-timeline
// metronome. It is added to the mixer in place of the bare transport, so its lifetime is managed by
// JUCE's add/removeInputSource locking (no separate real-time lifetime hazard).
//
// Timing: the editor's beat grid lives in SOURCE time (`beatAnchorSec` + k·60/bpm). The preview
// plays from `inMs` and may be time-warped, so source time maps to played time as
// played = (source − inMs)/ratio. We therefore click at an EFFECTIVE bpm of bpm·ratio (so the
// played beat period matches the warped audio) and feed the shared Metronome a virtual play
// position offset by the grid phase, reusing its exact click generator. A constant warp ratio is
// assumed; Rubber Band's small processing latency is not compensated (clicks can sit a few ms off
// on a heavily warped clip — a refinement, not a correctness break).
class PreviewMetronomeSource : public juce::AudioSource
{
  public:
    explicit PreviewMetronomeSource(juce::AudioTransportSource& innerSource) : inner(innerSource) {}

    void setEnabled(bool e) noexcept { metro.setEnabled(e); }
    bool isEnabled() const noexcept { return metro.isEnabled(); }

    // Editor grid: source BPM + phase anchor (source seconds).
    void setGrid(double bpm, double beatAnchorSec) noexcept
    {
        gridBpm.store(bpm, std::memory_order_release);
        anchorSec.store(beatAnchorSec, std::memory_order_release);
    }

    // Preview mapping: the clip's in-point (ms into the source) and the active warp tempo ratio.
    void setClipMapping(double inPointMs, double tempoRatio) noexcept
    {
        inMs.store(inPointMs, std::memory_order_release);
        ratio.store(tempoRatio > 0.0 ? tempoRatio : 1.0, std::memory_order_release);
    }

    void prepareToPlay(int samplesPerBlockExpected, double newSampleRate) override
    {
        inner.prepareToPlay(samplesPerBlockExpected, newSampleRate);
        metro.prepare(newSampleRate);
        sampleRate = newSampleRate;
    }

    void releaseResources() override { inner.releaseResources(); }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        // Capture the start-of-block played position BEFORE pulling (the pull advances the
        // transport), mirroring how the main metronome samples the transport position.
        const double posBeforeSec = inner.getCurrentPosition();
        inner.getNextAudioBlock(info);
        if (info.buffer == nullptr || info.numSamples <= 0) return;
        if (! metro.isEnabled() || ! inner.isPlaying() || sampleRate <= 0.0) return;

        const double bpm = gridBpm.load(std::memory_order_acquire);
        if (bpm <= 0.0) return;
        const double r = ratio.load(std::memory_order_acquire);
        const double effBpm = bpm * r; // played-time beat rate for a warped clip
        const double beatPeriod = sampleRate * 60.0 / effBpm;
        if (beatPeriod < 1.0) return;

        // Played-sample position of the grid phase anchor, folded into [0, beatPeriod) so beats
        // tile the whole clip (covering beats both sides of the anchor).
        const double anchorPlayed = ((anchorSec.load(std::memory_order_acquire)
                                      - inMs.load(std::memory_order_acquire) / 1000.0)
                                     / r)
                                    * sampleRate;
        double anchorMod = std::fmod(anchorPlayed, beatPeriod);
        if (anchorMod < 0.0) anchorMod += beatPeriod;

        // Feed the shared click generator a virtual position so its beats land on the grid phase.
        const auto virtualStart =
            static_cast<juce::int64>(std::llround(posBeforeSec * sampleRate - anchorMod));
        metro.setBpm(effBpm);
        metro.render(*info.buffer, info.startSample, info.numSamples, virtualStart, sampleRate);
    }

  private:
    juce::AudioTransportSource& inner;
    Metronome metro;
    double sampleRate{0.0};
    std::atomic<double> gridBpm{0.0};
    std::atomic<double> anchorSec{0.0};
    std::atomic<double> inMs{0.0};
    std::atomic<double> ratio{1.0};
};

} // namespace silverdaw
