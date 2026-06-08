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
    }

    /** Clears DSP state on stop/seek; pause deliberately does not reset. */
    void reset() noexcept
    {
        tone.reset();
        leveler.reset();
    }

    /** Message-thread setter under the `BusGraph` lock; `snap` preserves setup parity. */
    void setTone(float bassDb, float midDb, float trebleDb, bool lowCut,
                 bool highCut, bool snap) noexcept
    {
        tone.setParams(bassDb, midDb, trebleDb, lowCut, highCut, snap);
    }

    /** Message-thread setter under the `BusGraph` lock; `snap` preserves setup parity. */
    void setLeveler(float amount, bool snap) noexcept { leveler.setParams(amount, snap); }

    /** Processes only the active buffer region; identity params remain sample-transparent. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        tone.process(buffer, startSample, numSamples);
        leveler.process(buffer, startSample, numSamples);
    }

    TrackChain(const TrackChain&) = delete;
    TrackChain& operator=(const TrackChain&) = delete;
    // Plain-value nodes make default moves safe for vector-owned offline tracks.
    TrackChain(TrackChain&&) noexcept = default;
    TrackChain& operator=(TrackChain&&) noexcept = default;

private:
    ToneEq tone;
    Leveler leveler;
};

} // namespace silverdaw
