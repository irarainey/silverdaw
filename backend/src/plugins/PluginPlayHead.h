#pragma once

#include <atomic>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace silverdaw::plugins
{

// The transport, as a hosted plugin sees it. A tempo-synced delay or an LFO that follows the
// beat is useless without one, and JUCE calls `getPosition()` from inside `processBlock` on the
// audio thread — so this reads nothing but atomics and allocates nothing (ADR 0006).
//
// One instance is shared by every hosted plugin: they all follow the same transport. Position,
// sample rate and play state are *read from* the engine's own atomics rather than mirrored into
// copies, so what a plugin sees cannot drift from what the renderer is doing. Tempo is pushed,
// because the project tempo lives in ProjectState rather than in an engine atomic.
class PluginPlayHead final : public juce::AudioPlayHead
{
  public:
    /** Message thread, once at setup. All three sources must outlive this play head. */
    void setTransportSources(const std::atomic<juce::int64>* positionSamples,
                             const std::atomic<double>* rate,
                             const std::atomic<bool>* isPlaying) noexcept
    {
        positionSource.store(positionSamples, std::memory_order_release);
        rateSource.store(rate, std::memory_order_release);
        playingSource.store(isPlaying, std::memory_order_release);
    }

    /** Message thread. Project tempo, in quarter-note beats per minute. */
    void setBpm(double newBpm) noexcept
    {
        if (newBpm > 0.0) bpm.store(newBpm, std::memory_order_relaxed);
    }

    double getBpm() const noexcept { return bpm.load(std::memory_order_relaxed); }

    /** Audio thread, from inside the plugin's own `processBlock`. */
    juce::Optional<PositionInfo> getPosition() const override
    {
        const auto tempo = bpm.load(std::memory_order_relaxed);
        const auto samples = loadOr<juce::int64>(positionSource, 0);
        const auto rate = loadOr<double>(rateSource, 0.0);
        const auto seconds = rate > 0.0 ? static_cast<double>(samples) / rate : 0.0;

        PositionInfo info;
        info.setTimeInSamples(samples);
        info.setTimeInSeconds(seconds);
        info.setBpm(tempo);
        // Silverdaw is 4/4 by design, so the signature is stated rather than guessed: a
        // plugin that syncs to bars needs *some* signature, and this is the only one.
        info.setTimeSignature(TimeSignature{4, 4});
        info.setPpqPosition(seconds * tempo / 60.0);
        info.setIsPlaying(loadOr<bool>(playingSource, false));
        info.setIsRecording(false);
        return info;
    }

  private:
    template <typename T>
    static T loadOr(const std::atomic<const std::atomic<T>*>& source, T fallback) noexcept
    {
        const auto* p = source.load(std::memory_order_acquire);
        return p != nullptr ? p->load(std::memory_order_relaxed) : fallback;
    }

    std::atomic<const std::atomic<juce::int64>*> positionSource{nullptr};
    std::atomic<const std::atomic<double>*> rateSource{nullptr};
    std::atomic<const std::atomic<bool>*> playingSource{nullptr};
    std::atomic<double> bpm{120.0};
};

} // namespace silverdaw::plugins
