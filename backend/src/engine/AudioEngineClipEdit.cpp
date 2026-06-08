#include "AudioEngine.h"
#include "AudioConstants.h"
#include "AudioEngineWarpFactory.h"
#include "Log.h"

#include <cmath>

namespace silverdaw
{
void AudioEngine::setPositionMs(double ms)
{
    const double sr = master.getSampleRate();
    const double clampedMs = juce::jmax(0.0, ms);
    const auto masterSamples = sr > 0.0
                                   ? static_cast<juce::int64>(clampedMs * sr / 1000.0)
                                   : static_cast<juce::int64>(0);
    master.setPositionSamples(masterSamples);

    busGraph.resetSharedFx();
    // Deep read-ahead priming avoids JUCE BufferingAudioSource dropping cold samples at play
    // start.
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource == nullptr) continue;
        track->transportSource->setPosition(trackSeekSecondsFor(*track, masterSamples));
        track->prefetchDirty = true;
    }
    rebuildTimer.startTimer(master.isPlaying() ? 1 : kRebuildDebounceMs);
    if (! master.isPlaying())
    {
        pendingSeekPrewarm = true;
    }
    silverdaw::log::info("engine", "setPositionMs " + juce::String(clampedMs));
}

bool AudioEngine::setClipOffsetMs(const juce::String& clipId, double offsetMs)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        return false;
    }

    auto& track = it->second;
    if (track->offsetSource == nullptr || track->transportSource == nullptr)
    {
        return false;
    }

    const double clampedMs = juce::jmax(0.0, offsetMs);
    const auto newOffsetSamples = static_cast<juce::int64>(clampedMs * track->sampleRate / 1000.0);

    // Rebuild stale JUCE read-ahead buffers after timeline changes so playback starts at the
    // new position.
    track->offsetSource->setOffsetSamples(newOffsetSamples);
    track->offsetSource->requestWarpReseek();

    if (master.isPlaying())
    {
        rebuildTrackPrefetch(*track);
    }
    else
    {
        track->prefetchDirty = true;
        rebuildTimer.startTimer(kRebuildDebounceMs);
    }

    return true;
}

bool AudioEngine::commitClipOffset(const juce::String& clipId)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end()) return false;
    rebuildTrackPrefetch(*it->second);
    return true;
}

bool AudioEngine::setClipTrim(const juce::String& clipId, double startMs, double inMs, double clipDurationMs)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        return false;
    }

    auto& track = it->second;
    if (track->offsetSource == nullptr || track->transportSource == nullptr)
    {
        return false;
    }

    const double sr = track->sampleRate;
    const auto offsetSamples =
        static_cast<juce::int64>(juce::jmax(0.0, startMs) * sr / 1000.0);
    const auto inSampleOffset =
        static_cast<juce::int64>(juce::jmax(0.0, inMs) * sr / 1000.0);
    const auto durSamples =
        static_cast<juce::int64>(juce::jmax(0.0, clipDurationMs) * sr / 1000.0);

    // Message-thread writes are published for bounded, lock-free audio-thread reads.
    track->offsetSource->setClipWindowAtomic(offsetSamples, inSampleOffset, durSamples);

    if (master.isPlaying())
    {
        rebuildTrackPrefetch(*track);
    }
    else
    {
        track->prefetchDirty = true;
        rebuildTimer.startTimer(kRebuildDebounceMs);
    }

    return true;
}

bool AudioEngine::setClipEnvelope(const juce::String& clipId, const juce::Array<juce::var>& points)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        return false;
    }
    auto& track = it->second;
    if (track->offsetSource == nullptr)
    {
        return false;
    }

    auto snapshot = EnvelopeSnapshot::fromVarArray(points);
    const EnvelopeSnapshot* published = snapshot->isEmpty() ? nullptr : snapshot.get();

    // Retire replaced snapshots/processors until the audio thread is quiescent.
    track->offsetSource->setEnvelopeSnapshot(published);
    if (track->envelopeSnapshot != nullptr)
    {
        track->retiredEnvelopes.push_back(std::move(track->envelopeSnapshot));
    }
    track->envelopeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;
    return true;
}

bool AudioEngine::setClipEdgeFade(const juce::String& clipId,
                                  bool hasFadeIn, double fadeInStartMs, double fadeInEndMs,
                                  bool hasFadeOut, double fadeOutStartMs, double fadeOutEndMs)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        return false;
    }
    auto& track = it->second;
    if (track->offsetSource == nullptr)
    {
        return false;
    }

    const double sr = track->sampleRate > 0.0 ? track->sampleRate : 44100.0;
    const auto toSamples = [sr](double ms) {
        return static_cast<juce::int64>(juce::jmax(0.0, ms) * sr / 1000.0);
    };

    auto snapshot = EdgeFadeSnapshot::create(
        hasFadeIn, toSamples(fadeInStartMs), toSamples(fadeInEndMs),
        hasFadeOut, toSamples(fadeOutStartMs), toSamples(fadeOutEndMs));
    const EdgeFadeSnapshot* published =
        (snapshot != nullptr && !snapshot->isEmpty()) ? snapshot.get() : nullptr;

    track->offsetSource->setEdgeFadeSnapshot(published);
    if (track->edgeFadeSnapshot != nullptr)
    {
        track->retiredEdgeFades.push_back(std::move(track->edgeFadeSnapshot));
    }
    track->edgeFadeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;
    return true;
}

bool AudioEngine::setClipWarp(const juce::String& clipId,
                              std::optional<bool> enabled,
                              std::optional<juce::String> mode,
                              std::optional<double> tempoRatio,
                              std::optional<double> semitones,
                              std::optional<double> cents)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end()) return false;
    auto& track = it->second;
    if (track->offsetSource == nullptr) return false;

    const bool wantEnabled = enabled.value_or(track->warp != nullptr);

    if (!wantEnabled)
    {
        track->offsetSource->setWarpProcessor(nullptr);
        if (track->warp != nullptr)
        {
            track->retiredWarps.push_back(std::move(track->warp));
        }
        if (master.isPlaying())
        {
            rebuildTrackPrefetch(*track);
        }
        else
        {
            track->prefetchDirty = true;
            rebuildTimer.startTimer(kRebuildDebounceMs);
        }
        silverdaw::log::info("engine", "clip warp disabled " + clipId);
        return true;
    }

    // Silverdaw tempoRatio is project/source; Rubber Band receives the inverse internally.
    const bool needRebuild = (track->warp == nullptr) || mode.has_value();
    if (needRebuild)
    {
        const auto modeStr = mode.value_or(juce::String("rhythmic"));
        const auto& dm = deviceManager.getAudioDeviceSetup();
        auto wp = makeWarpProcessor(track->numChannels, track->sampleRate,
                                    static_cast<int>(dm.bufferSize), modeStr,
                                    tempoRatio, semitones, cents);
        if (track->warp != nullptr)
        {
            track->retiredWarps.push_back(std::move(track->warp));
        }
        track->warp = std::move(wp);
        track->offsetSource->setWarpProcessor(track->warp.get());
        track->offsetSource->requestWarpReseek();
        silverdaw::log::info("engine",
            "clip warp built " + clipId + " mode=" + modeStr);
    }

    if (auto* w = track->warp.get())
    {
        if (tempoRatio.has_value() && *tempoRatio > 0.0)
        {
            w->setTempoRatio(*tempoRatio);
        }
        if (semitones.has_value() || cents.has_value())
        {
            const double s = semitones.value_or(0.0);
            const double c = cents.value_or(0.0);
            const double scale = std::pow(2.0, (s + c / 100.0) / 12.0);
            w->setPitchScale(scale);
        }
    }

    if (master.isPlaying())
    {
        rebuildTrackPrefetch(*track);
    }
    else
    {
        track->prefetchDirty = true;
        rebuildTimer.startTimer(kRebuildDebounceMs);
    }
    return true;
}
} // namespace silverdaw
