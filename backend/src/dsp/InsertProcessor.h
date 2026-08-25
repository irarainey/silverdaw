#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Hook for third-party inserts hosted outside the dsp layer (ADR 0025). Keeping the
// interface here lets TrackChain hold the canonical insert position without pulling
// plugin-hosting headers into every dsp translation unit.
class InsertProcessor
{
public:
    virtual ~InsertProcessor() = default;

    /** Audio thread. Implementations may call third-party code, so this is the one
     *  place in the chain that is not bound by ADR 0006 in full. */
    virtual void processInserts(juce::AudioBuffer<float>& buffer, int startSample,
                                int numSamples) noexcept = 0;

    /** Audio thread. Drops ramp state on a stop/seek discontinuity. */
    virtual void resetInserts() noexcept = 0;
};

} // namespace silverdaw
