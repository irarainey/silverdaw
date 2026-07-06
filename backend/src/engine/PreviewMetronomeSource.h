#pragma once

#include "AudioConstants.h"
#include "Metronome.h"
#include "OutputKeepAlive.h"

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
//
// Device wake: this wrapper is the preview's single mixer input, so it also runs the same wake
// pre-roll the main transport does (see MasterClockSource). On a sleep-prone (USB) endpoint, the
// first block of each play holds the preview silent for a short lead-in while the shared
// OutputKeepAlive emits its decaying wake burst, rousing the DAC's auto-mute amp before the first
// audible sample. This keeps the Clip Editor / preview window on the exact same device rules as
// timeline playback, so a cold amp no longer swallows the opening of a preview.
class PreviewMetronomeSource : public juce::AudioSource
{
  public:
    PreviewMetronomeSource(juce::AudioTransportSource& innerSource, OutputKeepAlive& keepAliveRef)
        : inner(innerSource), keepAlive(keepAliveRef) {}

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
        prerollSamples = newSampleRate > 0.0
            ? static_cast<int>(newSampleRate * (silverdaw::kWakePrerollMs / 1000.0))
            : 0;
        wakePrerollRemaining = 0;
        wasPlaying = false;
    }

    void releaseResources() override { inner.releaseResources(); }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        // Wake pre-roll (audio thread): on a stopped->playing transition, a sleep-prone (USB)
        // endpoint gets a short silent lead-in during which OutputKeepAlive (via MeteringSource)
        // emits its decaying wake burst, rousing the DAC's auto-mute amp before the first audible
        // sample. The inner transport is NOT pulled while the pre-roll runs, so the downbeat is
        // preserved and plays at full level the instant the amp is awake. Non-sleep-prone endpoints
        // skip it and play instantly. Mirrors MasterClockSource so preview follows the same rules.
        const bool playingNow = inner.isPlaying();
        if (playingNow && ! wasPlaying)
        {
            // Only rouse a genuinely cold endpoint: a warm amp (real audio played within the warm
            // window) is already awake, so bursting into it would just add an audible start-of-play
            // hiss — most obvious auditioning clips with leading silence back-to-back. A cold endpoint
            // still gets the full silent pre-roll + wake burst so its opening is never swallowed.
            if (keepAlive.isKeepAwakeEnabled() && ! keepAlive.isWarm())
            {
                wakePrerollRemaining = prerollSamples;
                keepAlive.armWakeBurst();
            }
            else
            {
                wakePrerollRemaining = 0;
            }
        }
        wasPlaying = playingNow;

        if (wakePrerollRemaining > 0 && info.numSamples > 0)
        {
            info.clearActiveBufferRegion();
            wakePrerollRemaining = juce::jmax(0, wakePrerollRemaining - info.numSamples);
            return;
        }

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
    OutputKeepAlive& keepAlive;
    Metronome metro;
    double sampleRate{0.0};
    std::atomic<double> gridBpm{0.0};
    std::atomic<double> anchorSec{0.0};
    std::atomic<double> inMs{0.0};
    std::atomic<double> ratio{1.0};
    // Wake pre-roll state — audio-thread only. prerollSamples is the armed length (set for the
    // active rate in prepareToPlay); wakePrerollRemaining counts down the current lead-in; wasPlaying
    // tracks the inner transport's play state to detect a stopped->playing edge on the audio thread.
    int prerollSamples{0};
    int wakePrerollRemaining{0};
    bool wasPlaying{false};
};

} // namespace silverdaw
