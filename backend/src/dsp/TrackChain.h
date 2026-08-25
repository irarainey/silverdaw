#pragma once

#include "BitCrusher.h"
#include "InsertProcessor.h"
#include "Leveler.h"
#include "Punch.h"
#include "Saturation.h"
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
        punch.prepare(sampleRate);
        saturation.prepare(sampleRate);
        bitCrusher.prepare(sampleRate, numChannels);
        levelGain = 1.0F;
        targetLevelGain.store(1.0F, std::memory_order_relaxed);
        levelSnapRequested.store(false, std::memory_order_relaxed);
    }

    /** Clears DSP state on stop/seek; pause deliberately does not reset. */
    void reset() noexcept
    {
        tone.reset();
        leveler.reset();
        punch.reset();
        saturation.reset();
        bitCrusher.reset();
        if (auto* i = inserts.load(std::memory_order_acquire)) i->resetInserts();
        levelGain = targetLevelGain.load(std::memory_order_relaxed);
        levelSnapRequested.store(false, std::memory_order_relaxed);
    }

    /** Message-thread setter under the `BusGraph` lock; `snap` preserves setup parity.
     *  `filter` is the bipolar DJ-style sweep in `[-1, +1]` (see `ToneEq::setParams`). */
    void setTone(float bassDb, float midDb, float trebleDb, float filter, bool snap) noexcept
    {
        tone.setParams(bassDb, midDb, trebleDb, filter, snap);
    }

    /** Message-thread setter under the `BusGraph` lock; `snap` preserves setup parity. */
    void setLeveler(float amount, bool snap) noexcept { leveler.setParams(amount, snap); }
    void setPunch(float amount, bool snap) noexcept { punch.setAmount(amount, snap); }
    void setSaturation(float drive, float mix, bool snap) noexcept
    {
        saturation.setParams(drive, mix, snap);
    }
    void setBitCrusher(float rate, int bits, float boost, float mix, bool snap) noexcept
    {
        bitCrusher.setParams(rate, bits, boost, mix, snap);
    }

    /** Audio-thread filter-only automation update (see `ToneEq::setFilterTarget`). */
    void setFilterTarget(float filter, bool snap) noexcept { tone.setFilterTarget(filter, snap); }
    void setBassTarget(float db, bool snap) noexcept { tone.setBassTarget(db, snap); }
    void setMidTarget(float db, bool snap) noexcept { tone.setMidTarget(db, snap); }
    void setTrebleTarget(float db, bool snap) noexcept { tone.setTrebleTarget(db, snap); }
    void setSaturationDriveTarget(float drive, bool snap) noexcept
    {
        saturation.setDriveTarget(drive, snap);
    }
    void setPunchTarget(float amount, bool snap) noexcept { punch.setAmount(amount, snap); }
    void setSaturationMixTarget(float mix, bool snap) noexcept
    {
        saturation.setMixTarget(mix, snap);
    }
    void setBitCrusherRateTarget(float rate, bool snap) noexcept
    {
        bitCrusher.setRateTarget(rate, snap);
    }
    void setBitCrusherBitsTarget(float bits, bool snap) noexcept
    {
        bitCrusher.setBitsTarget(bits, snap);
    }
    void setBitCrusherBoostTarget(float boost, bool snap) noexcept
    {
        bitCrusher.setBoostTarget(boost, snap);
    }
    void setBitCrusherMixTarget(float mix, bool snap) noexcept
    {
        bitCrusher.setMixTarget(mix, snap);
    }

    /** Automatable post-chain track level in dB. Ramped per block to avoid clicks;
     *  `snap` is consumed by the audio thread on a seek/loop discontinuity. 0 dB is unity. */
    void setLevelTarget(float db, bool snap) noexcept
    {
        targetLevelGain.store(juce::Decibels::decibelsToGain(db, -120.0F),
                              std::memory_order_relaxed);
        if (snap) levelSnapRequested.store(true, std::memory_order_release);
    }

    /** Message-thread setter, published for the audio thread. Null detaches the inserts;
     *  the caller must keep the processor alive until the audio thread has left it. */
    void setInserts(InsertProcessor* processor) noexcept
    {
        inserts.store(processor, std::memory_order_release);
    }

    /** Processes only the active buffer region; identity params remain sample-transparent. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        tone.process(buffer, startSample, numSamples);
        leveler.process(buffer, startSample, numSamples);
        saturation.process(buffer, startSample, numSamples);
        bitCrusher.process(buffer, startSample, numSamples);
        punch.process(buffer, startSample, numSamples);
        // Inserts sit at the end of tonal shaping and upstream of level, sends and pan,
        // so a plugin cannot change what mute, solo or a send amount means (ADR 0025).
        if (auto* i = inserts.load(std::memory_order_acquire))
            i->processInserts(buffer, startSample, numSamples);
        const float target = targetLevelGain.load(std::memory_order_relaxed);
        if (levelSnapRequested.exchange(false, std::memory_order_acquire))
            levelGain = target;
        if (levelGain != target)
        {
            buffer.applyGainRamp(startSample, numSamples, levelGain, target);
            levelGain = target;
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
    Punch punch;
    Saturation saturation;
    BitCrusher bitCrusher;
    float levelGain = 1.0F;
    std::atomic<InsertProcessor*> inserts{nullptr};
    std::atomic<float> targetLevelGain{1.0F};
    std::atomic<bool> levelSnapRequested{false};

    static_assert(std::atomic<float>::is_always_lock_free,
                  "TrackChain level target must be lock-free on the audio thread");
};

} // namespace silverdaw
