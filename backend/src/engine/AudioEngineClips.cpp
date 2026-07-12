#include "AudioEngine.h"
#include "AudioConstants.h"
#include "AudioEngineWarpFactory.h"
#include "Log.h"

#include <cmath>

namespace silverdaw
{
double AudioEngine::trackSeekSecondsFor(const Track& track, juce::int64 masterSamples) const
{
    const juce::int64 compensated = juce::jmax(static_cast<juce::int64>(0), masterSamples - track.latencySamples);
    const double sr = master.getSampleRate() > 0.0 ? master.getSampleRate() : track.sampleRate;
    return sr > 0.0 ? static_cast<double>(compensated) / sr : 0.0;
}

std::unique_ptr<juce::AudioFormatReader> AudioEngine::createReaderForClip(const juce::File& filePath)
{
    if (!filePath.existsAsFile()) return nullptr;
    auto* reader = formatManager.createReaderFor(filePath);
    if (reader == nullptr)
    {
        // Windows Media Foundation support comes from JUCE built-in format registration.
        if (auto stream = filePath.createInputStream())
        {
            reader = formatManager.createReaderFor(std::move(stream));
        }
    }
    return std::unique_ptr<juce::AudioFormatReader>(reader);
}

bool AudioEngine::addClip(const juce::String& trackId, const juce::String& clipId, const juce::File& filePath,
                          double initialOffsetMs, double inMs, double clipDurationMs, float initialGain,
                          juce::String* outError)
{
    if (!filePath.existsAsFile())
    {
        const auto msg = "file does not exist: " + filePath.getFullPathName();
        silverdaw::log::warn("addClip", msg);
        if (outError != nullptr)
        {
            *outError = msg;
        }
        return false;
    }

    auto reader = createReaderForClip(filePath);
    if (reader == nullptr)
    {
        juce::StringArray formatNames;
        for (int i = 0; i < formatManager.getNumKnownFormats(); ++i)
        {
            auto* af = formatManager.getKnownFormat(i);
            formatNames.add(af != nullptr ? af->getFormatName() : juce::String("<null>"));
        }
        const auto msg = "createReaderFor returned null (ext=" + filePath.getFileExtension() +
                         ", size=" + juce::String(filePath.getSize()) + " bytes, registered=[" +
                         formatNames.joinIntoString(", ") + "])";
        silverdaw::log::warn("addClip", msg);
        if (outError != nullptr)
        {
            *outError = msg;
        }
        return false;
    }

    return addClip(trackId, clipId, std::move(reader), filePath, initialOffsetMs, inMs, clipDurationMs,
                   initialGain, outError);
}

bool AudioEngine::addClip(const juce::String& trackId, const juce::String& clipId,
                          std::unique_ptr<juce::AudioFormatReader> reader, const juce::File& filePath,
                          double initialOffsetMs, double inMs, double clipDurationMs, float initialGain,
                          juce::String* outError)
{
    silverdaw::log::info("engine", "addClip trackId=" + trackId + " id=" + clipId +
                                        " offsetMs=" + juce::String(initialOffsetMs) +
                                        " inMs=" + juce::String(inMs) + " durMs=" + juce::String(clipDurationMs) +
                                        " path=" + filePath.getFileName());
    if (trackId.isEmpty())
    {
        const auto msg = juce::String("addClip requires non-empty trackId");
        silverdaw::log::warn("addClip", msg);
        if (outError != nullptr) *outError = msg;
        return false;
    }
    if (reader == nullptr)
    {
        const auto msg = "could not read audio file: " + filePath.getFullPathName();
        silverdaw::log::warn("addClip", msg);
        if (outError != nullptr) *outError = msg;
        return false;
    }

    auto track = std::make_unique<Track>();
    track->trackId = trackId;
    track->sampleRate = reader->sampleRate;
    track->numChannels = static_cast<int>(reader->numChannels);
    trackAudibility[trackId] = initialGain > 0.0F;

    track->readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader.release(), true);

    // Deep read-ahead priming avoids JUCE BufferingAudioSource dropping cold samples at play
    // start.
    track->offsetSource = std::make_unique<OffsetSource>(track->readerSource.get());
    // Rebuild stale JUCE read-ahead buffers after timeline changes so playback starts at the
    // new position.
    const double clampedInitialMs = juce::jmax(0.0, initialOffsetMs);
    track->offsetSource->setOffsetSamples(
        static_cast<juce::int64>(clampedInitialMs * track->sampleRate / 1000.0));
    const double clampedInMs = juce::jmax(0.0, inMs);
    track->offsetSource->setInSourceSamples(
        static_cast<juce::int64>(clampedInMs * track->sampleRate / 1000.0));
    const double clampedDurMs = juce::jmax(0.0, clipDurationMs);
    track->offsetSource->setClipDurationSamples(
        static_cast<juce::int64>(clampedDurMs * track->sampleRate / 1000.0));

    track->transportSource = std::make_unique<juce::AudioTransportSource>();
    track->bufferingSource = std::make_unique<juce::BufferingAudioSource>(
        track->offsetSource.get(), readAheadThread,
        /*deleteSourceWhenDeleted=*/false,
        kTransportReadAheadSamples, track->numChannels);
    track->transportSource->setSource(track->bufferingSource.get(),
                                      0,       // read-ahead handled by our owned bufferingSource
                                      nullptr, // ditto — no extra reader thread
                                      track->sampleRate, track->numChannels);
    track->transportSource->setGain(juce::jlimit(kMinTrackGain, kMaxTrackGain, initialGain));

    if (isTrackAudible(trackId))
        track->transportSource->start();

    track->transportSource->setPosition(trackSeekSecondsFor(*track, master.getPositionSamples()));

    const bool wasPlaying = master.isPlaying();
    if (wasPlaying)
    {
        master.setPlaying(false);
    }

    if (auto it = tracks.find(clipId); it != tracks.end())
    {
        busGraph.detachClip(clipId, it->second->transportSource.get());
        tracks.erase(it);
    }

    busGraph.attachClip(trackId, clipId, track->transportSource.get(),
                        isTrackAudible(trackId));
    tracks.emplace(clipId, std::move(track));

    if (wasPlaying)
    {
        master.setPlaying(true);
    }

    // Keep-alive only wakes sleep-prone endpoints; idle output remains true digital silence.
    master.setContentLoaded(! tracks.empty());

    return true;
}

bool AudioEngine::removeClip(const juce::String& clipId)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        silverdaw::log::warn("engine", "removeClip unknown id=" + clipId);
        return false;
    }

    const juce::String trackId = it->second->trackId;
    busGraph.detachClip(clipId, it->second->transportSource.get());
    it->second->transportSource->setSource(nullptr);
    tracks.erase(it);
    const bool trackStillHasClips =
        std::any_of(tracks.begin(), tracks.end(),
                    [&trackId](const auto& entry) {
                        return entry.second->trackId == trackId;
                    });
    if (!trackStillHasClips)
    {
        pendingTrackBypasses.erase(trackId);
        trackAudibility.erase(trackId);
        if (pendingTrackBypasses.empty())
            trackBypassTimer.stopTimer();
    }
    master.setContentLoaded(! tracks.empty());
    silverdaw::log::info("engine", "removeClip id=" + clipId);
    return true;
}

bool AudioEngine::moveClipToTrack(const juce::String& clipId,
                                  const juce::String& trackId)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end() || trackId.isEmpty())
    {
        silverdaw::log::warn("engine", "moveClipToTrack invalid clip or track id");
        return false;
    }

    auto& track = *it->second;
    const juce::String oldTrackId = track.trackId;
    if (oldTrackId == trackId) return true;

    busGraph.detachClip(clipId, track.transportSource.get(), false);
    track.trackId = trackId;
    const bool destinationAudible = isTrackAudible(trackId);

    if (destinationAudible && track.transportSource != nullptr)
    {
        const double seekSeconds =
            trackSeekSecondsFor(track, master.getPositionSamples());
        if (track.prefetchDirty)
            recreateTrackPrefetch(track, seekSeconds);
        else
            track.transportSource->setPosition(seekSeconds);

        if (master.isPlaying())
        {
            track.transportSource->start();
            juce::AudioBuffer<float> scratch(
                juce::jmax(1, track.numChannels), kPrimeReadyTargetSamples);
            const double deadline = juce::Time::getMillisecondCounterHiRes()
                + static_cast<double>(kPrimePerTrackTimeoutMs);
            if (!waitForTrackPrefetch(track, deadline, scratch))
                silverdaw::log::warn(
                    "engine", "moved track prefetch incomplete id=" + trackId);
        }
    }

    busGraph.attachClip(trackId, clipId, track.transportSource.get(),
                        destinationAudible, false);

    const bool oldTrackStillHasClips =
        std::any_of(tracks.begin(), tracks.end(),
                    [&oldTrackId](const auto& entry) {
                        return entry.second->trackId == oldTrackId;
                    });
    if (!oldTrackStillHasClips)
    {
        pendingTrackBypasses.erase(oldTrackId);
        trackAudibility.erase(oldTrackId);
        if (pendingTrackBypasses.empty())
            trackBypassTimer.stopTimer();
    }

    silverdaw::log::info("engine", "moveClipToTrack id=" + clipId
        + " trackId=" + trackId);
    return true;
}

bool AudioEngine::setClipGain(const juce::String& clipId, float gain)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        silverdaw::log::warn("engine", "setClipGain unknown id=" + clipId);
        return false;
    }

    if (it->second->transportSource != nullptr)
    {
        it->second->transportSource->setGain(juce::jlimit(kMinTrackGain, kMaxTrackGain, gain));
    }
    silverdaw::log::debug("engine", "setClipGain id=" + clipId + " gain=" + juce::String(gain));
    return true;
}

void AudioEngine::recreateTrackPrefetch(Track& track, double positionSeconds)
{
    track.transportSource->setSource(nullptr);
    track.bufferingSource = std::make_unique<juce::BufferingAudioSource>(
        track.offsetSource.get(), readAheadThread,
        /*deleteSourceWhenDeleted=*/false,
        kTransportReadAheadSamples, track.numChannels);
    track.transportSource->setSource(track.bufferingSource.get(),
                                     0, nullptr,
                                     track.sampleRate, track.numChannels);
    track.transportSource->setPosition(positionSeconds);
    track.prefetchDirty = false;
}

void AudioEngine::rebuildTrackPrefetch(Track& track)
{
    if (track.transportSource == nullptr || track.offsetSource == nullptr)
    {
        return;
    }
    if (!isTrackAudible(track.trackId))
    {
        track.prefetchDirty = true;
        return;
    }
    const double pos = trackSeekSecondsFor(track, master.getPositionSamples());
    silverdaw::log::info("engine", "invalidate prefetch (pos=" + juce::String(pos) + ")");

    if (! master.isPlaying())
    {
        // Stopped edits (move / trim / envelope / reverse / edge-fade / brake / backspin / warp)
        // change the OffsetSource UPSTREAM of the read-ahead buffer, but juce::BufferingAudioSource
        // has no synchronous flush: setNextReadPosition only moves nextPlayPos and wakes the
        // background thread, so a far-then-near seek on the message thread reverts nextPlayPos
        // before that thread observes the far position — the stale valid range (buffered at the old
        // offset) survives, and primeTracksForPlayback's waitForNextAudioBlockReady accepts it as
        // "ready". The result is a burst of the clip's pre-edit audio on the next play. Recreating
        // the owned BufferingAudioSource is the only reliable flush (mirrors rebuildPreviewReadAhead)
        // — the new buffer has an empty valid range, forcing a fresh read from the updated
        // OffsetSource. Safe while stopped: MasterClockSource does not pull the BusGraph, and the
        // retired buffer removes itself from readAheadThread in its destructor.
        recreateTrackPrefetch(track, pos);
        return;
    }

    // While playing, recreating the source would force-stop the transport (JUCE resets its playing
    // flag in setSource). The stale read-ahead drains within one buffer during continuous playback,
    // so keep the opportunistic far-then-near seek for the live-edit case.
    track.transportSource->setPosition(pos + 3600.0);
    track.transportSource->setPosition(pos);
    track.prefetchDirty = false;
}

void AudioEngine::scheduleTrackPrefetchAfterEdit(Track& track)
{
    if (!isTrackAudible(track.trackId))
    {
        track.prefetchDirty = true;
        return;
    }
    if (master.isPlaying())
        rebuildTrackPrefetch(track);
    else
    {
        track.prefetchDirty = true;
        rebuildTimer.startTimer(kRebuildDebounceMs);
    }
}

void AudioEngine::flushAllDirtyRebuildsSync()
{
    for (auto& [id, track] : tracks)
    {
        if (track->prefetchDirty)
        {
            rebuildTrackPrefetch(*track);
        }
    }
}

void AudioEngine::flushDirtyRebuilds()
{
    constexpr double kBudgetMs = 2.0;
    constexpr int kFollowupMs = 1;

    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    bool anyRemaining = false;
    for (auto& [id, track] : tracks)
    {
        if (!track->prefetchDirty) continue;
        if ((juce::Time::getMillisecondCounterHiRes() - t0) >= kBudgetMs)
        {
            anyRemaining = true;
            break;
        }
        rebuildTrackPrefetch(*track);
    }
    if (anyRemaining)
    {
        for (auto& [id, track] : tracks)
        {
            if (track->prefetchDirty)
            {
                rebuildTimer.startTimer(kFollowupMs);
                return;
            }
        }
    }

    if (pendingSeekPrewarm && ! master.isPlaying())
    {
        pendingSeekPrewarm = false;
        const auto prewarmStart = juce::Time::getMillisecondCounterHiRes();
        const bool warm = primeTracksForPlayback(kLoadPrimeBudgetMs);
        silverdaw::log::info("engine",
                             "prewarm prefetch after seek settle (pos=" +
                                 juce::String(master.getPositionSamples()) + " warm=" +
                                 (warm ? "1" : "0") + " elapsedMs=" +
                                 juce::String(juce::Time::getMillisecondCounterHiRes() - prewarmStart, 1) +
                                 ")");
    }
}
} // namespace silverdaw
