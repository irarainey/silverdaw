#pragma once

#include "Leveler.h"
#include "ToneEq.h"

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Shared per-track DSP chain keeps live and export paths identical.
// Node state is per-track, not per-clip, to avoid detector/filter resets at clip edges.
// `process` must remain allocation/lock/resize free on the audio thread.
class TrackChain
{
public:
    TrackChain() = default;

    /** Allocates node state outside `process`; recalled for rate/block/channel changes. */
    void prepare(double sampleRate, int maxBlockSize, int numChannels) noexcept
    {
        juce::ignoreUnused(maxBlockSize);
        tone.prepare(sampleRate, numChannels);
        leveler.prepare(sampleRate, numChannels);
        levelGain = 1.0F;
        targetLevelGain = 1.0F;
    }

    /** Clears DSP state on stop/seek; pause deliberately does not reset. */
    void reset() noexcept
    {
        tone.reset();
        leveler.reset();
        levelGain = targetLevelGain;
    }

    /** Message-thread setter under the `BusGraph` lock; `snap` preserves setup parity.
     *  `filter` is the bipolar DJ-style sweep in `[-1, +1]` (see `ToneEq::setParams`). */
    void setTone(float bassDb, float midDb, float trebleDb, float filter, bool snap) noexcept
    {
        tone.setParams(bassDb, midDb, trebleDb, filter, snap);
    }

    /** Message-thread setter under the `BusGraph` lock; `snap` preserves setup parity. */
    void setLeveler(float amount, bool snap) noexcept { leveler.setParams(amount, snap); }

    /** Audio-thread filter-only automation update (see `ToneEq::setFilterTarget`). */
    void setFilterTarget(float filter, bool snap) noexcept { tone.setFilterTarget(filter, snap); }
    void setBassTarget(float db, bool snap) noexcept { tone.setBassTarget(db, snap); }
    void setMidTarget(float db, bool snap) noexcept { tone.setMidTarget(db, snap); }
    void setTrebleTarget(float db, bool snap) noexcept { tone.setTrebleTarget(db, snap); }

    /** Automatable post-chain track level in dB. Ramped per block to avoid clicks;
     *  `snap` lands immediately on seek/loop. 0 dB is unity. */
    void setLevelTarget(float db, bool snap) noexcept
    {
        targetLevelGain = juce::Decibels::decibelsToGain(db, -120.0F);
        if (snap) levelGain = targetLevelGain;
    }

    /** Processes only the active buffer region; identity params remain sample-transparent. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        tone.process(buffer, startSample, numSamples);
        leveler.process(buffer, startSample, numSamples);
        if (levelGain != targetLevelGain)
        {
            buffer.applyGainRamp(startSample, numSamples, levelGain, targetLevelGain);
            levelGain = targetLevelGain;
        }
        else if (levelGain != 1.0F)
        {
            buffer.applyGain(startSample, numSamples, levelGain);
        }
    }

    TrackChain(const TrackChain&) = delete;
    TrackChain& operator=(const TrackChain&) = delete;
    // Plain-value nodes make default moves safe for vector-owned offline tracks.
    TrackChain(TrackChain&&) noexcept = default;
    TrackChain& operator=(TrackChain&&) noexcept = default;

private:
    ToneEq tone;
    Leveler leveler;
    float levelGain = 1.0F;
    float targetLevelGain = 1.0F;
};

} // namespace silverdaw
