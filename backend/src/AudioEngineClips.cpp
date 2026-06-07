#include "AudioEngine.h"
#include "AudioConstants.h"
#include "AudioEngineWarpFactory.h"
#include "Log.h"

#include <cmath>

namespace silverdaw
{
double AudioEngine::trackSeekSecondsFor(const Track& track, juce::int64 masterSamples) const
{
    // Latency compensation: read this track `latencySamples` earlier than
    // master so a future delay-introducing processor downstream still
    // outputs samples aligned with master. Clamp negatives to 0 (a track
    // can't read from before the timeline starts).
    const juce::int64 compensated = juce::jmax(static_cast<juce::int64>(0), masterSamples - track.latencySamples);
    const double sr = master.getSampleRate() > 0.0 ? master.getSampleRate() : track.sampleRate;
    return sr > 0.0 ? static_cast<double>(compensated) / sr : 0.0;
}

bool AudioEngine::addClip(const juce::String& trackId, const juce::String& clipId, const juce::File& filePath,
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

    auto* reader = formatManager.createReaderFor(filePath);
    if (reader == nullptr)
    {
        // The File overload filters formats by extension. JUCE's WindowsMediaAudioFormat
        // only advertises .mp3/.wma/.wmv/.asf/.wm even though Media Foundation can also
        // decode .m4a/.mp4/.aac. Fall back to the stream overload, which lets every
        // registered format probe the bytes directly.
        if (auto stream = filePath.createInputStream())
        {
            reader = formatManager.createReaderFor(std::move(stream));
        }
    }
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

    auto track = std::make_unique<Track>();
    track->sampleRate = reader->sampleRate;
    track->numChannels = static_cast<int>(reader->numChannels);

    // `AudioFormatReaderSource` takes ownership of the reader (deleteWhenRemoved=true).
    track->readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader, true);

    // OffsetSource sits between the reader and the transport so any timeline
    // offset is reflected in the audio the transport's read-ahead buffer
    // pulls; the transport itself still represents the global timeline.
    track->offsetSource = std::make_unique<OffsetSource>(track->readerSource.get());
    // Apply the initial timeline offset BEFORE the transport begins prefetching,
    // so the very first samples the BufferingAudioSource pulls are at the right
    // place. Avoids a brief offset=0 glimpse if the clip is added during playback.
    const double clampedInitialMs = juce::jmax(0.0, initialOffsetMs);
    track->offsetSource->setOffsetSamples(
        static_cast<juce::int64>(clampedInitialMs * track->sampleRate / 1000.0));
    // Initial trim window: where in the source file to start reading, and
    // how long the clip plays for. Defaults of 0 mean "from the start"
    // and "to the end of the source" respectively — un-trimmed legacy
    // behaviour.
    const double clampedInMs = juce::jmax(0.0, inMs);
    track->offsetSource->setInSourceSamples(
        static_cast<juce::int64>(clampedInMs * track->sampleRate / 1000.0));
    const double clampedDurMs = juce::jmax(0.0, clipDurationMs);
    track->offsetSource->setClipDurationSamples(
        static_cast<juce::int64>(clampedDurMs * track->sampleRate / 1000.0));

    track->transportSource = std::make_unique<juce::AudioTransportSource>();
    // Own the read-ahead BufferingAudioSource explicitly instead of letting
    // AudioTransportSource create a hidden internal one. Owning it is what
    // lets us block-prime to an exact playhead via waitForNextAudioBlockReady
    // (see primeTracksForPlayback) so "press play" is instant from any
    // position. 8192 samples (~186 ms at 44.1 kHz) of read-ahead is plenty
    // for SSD-backed file reads — enough to hide disk-IO latency on a 60 Hz
    // audio callback without the heavy synchronous initial-fill cost a larger
    // buffer paid every time a clip was added (large buffers bit hard when
    // several duplicates of an MP3 source landed in quick succession, each
    // addClip blocking the message thread for ~1 s on a fresh buffer).
    track->bufferingSource = std::make_unique<juce::BufferingAudioSource>(
        track->offsetSource.get(), readAheadThread,
        /*deleteSourceWhenDeleted=*/false,
        kTransportReadAheadSamples, track->numChannels);
    // readAhead=0 / thread=nullptr here: the read-ahead is performed by our
    // owned bufferingSource above, so AudioTransportSource must not wrap it in
    // a second hidden BufferingAudioSource.
    track->transportSource->setSource(track->bufferingSource.get(),
                                      0,       // read-ahead handled by our owned bufferingSource
                                      nullptr, // ditto — no extra reader thread
                                      track->sampleRate, track->numChannels);
    track->transportSource->setGain(juce::jlimit(kMinTrackGain, kMaxTrackGain, initialGain));

    // Per-track transports are kept in the "started" state for their entire
    // lifetime in the engine. The master clock is the single play/pause gate;
    // when the gate is closed nobody pulls these transports, so they don't
    // advance. Starting them here means the first thing the master gate
    // does when it opens is hear audio, not silence-then-audio.
    track->transportSource->start();

    // Seek the new track to the current master position (latency-compensated)
    // so it joins playback in sync if added mid-session.
    track->transportSource->setPosition(trackSeekSecondsFor(*track, master.getPositionSamples()));

    // If we're currently playing, briefly close the master gate while we
    // swap the mixer input list. The audio callback will see a single
    // block of silence, which is acceptable for a clip-add event and
    // avoids any partial-state pull from a mixer mid-mutation.
    const bool wasPlaying = master.isPlaying();
    if (wasPlaying)
    {
        master.setPlaying(false);
    }

    // Replace any existing clip with the same id. The replacement
    // must come out of whatever `TrackRuntime` it currently lives on
    // (which may differ from the new `trackId` if the renderer moved
    // a clip between UI tracks while keeping the same `clipId`).
    if (auto it = tracks.find(clipId); it != tracks.end())
    {
        busGraph.detachClip(clipId, it->second->transportSource.get());
        tracks.erase(it);
    }

    // Lazily create the per-UI-track runtime on first clip for this
    // track. The runtime's inner mixer is what the project mixer
    // Route the new clip into its UI track's `TrackRuntime` via the
    // BusGraph. The runtime is created lazily on first clip per
    // `trackId`; the BusGraph also handles `prepareToPlay` if the
    // engine is already running. Clip transports are never added
    // directly to the project root — that would double-pull and
    // bypass the per-track chain (Phase 5 step 1c).
    busGraph.attachClip(trackId, clipId, track->transportSource.get());
    tracks.emplace(clipId, std::move(track));

    if (wasPlaying)
    {
        master.setPlaying(true);
    }

    // Track whether a project has audio content. This now feeds diagnostics
    // only — the keep-alive floor is gated on playback + wake pre-roll, not on
    // a project being loaded, so a loaded-but-stopped project stays silent.
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

    // Detach the clip from its TrackRuntime via the BusGraph first so
    // the audio thread stops pulling samples, then release the file
    // reader by clearing the transport's source. The BusGraph tears
    // down the TrackRuntime if this was its last clip — an empty
    // track doesn't keep a stale inner mixer in the project root.
    busGraph.detachClip(clipId, it->second->transportSource.get());
    it->second->transportSource->setSource(nullptr);
    tracks.erase(it);
    // Diagnostic content flag (no longer gates the floor — idle output is
    // always true silence regardless of whether a project is loaded).
    master.setContentLoaded(! tracks.empty());
    silverdaw::log::info("engine", "removeClip id=" + clipId);
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

void AudioEngine::rebuildTrackPrefetch(Track& track)
{
    if (track.transportSource == nullptr || track.offsetSource == nullptr)
    {
        return;
    }
    const double pos = trackSeekSecondsFor(track, master.getPositionSamples());
    silverdaw::log::info("engine", "invalidate prefetch (pos=" + juce::String(pos) + ")");
    // Force BufferingAudioSource to drop any stale cached blocks after
    // offset/trim changes without tearing down the source chain. A plain
    // setPosition(pos) can be a no-op when the master position did not
    // change, so first jump far outside the current buffer, then return
    // to the real target. Both calls are non-blocking and let the
    // read-ahead thread refill from the new OffsetSource mapping.
    track.transportSource->setPosition(pos + 3600.0);
    track.transportSource->setPosition(pos);
    track.prefetchDirty = false;
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
    // Time-budgeted batch rebuild. Each timer tick we drain dirty
    // tracks until either the queue is empty or we have spent more
    // than `kBudgetMs` of message-thread time on the loop, then
    // re-arm the timer at `kFollowupMs` to finish the rest in the
    // next tick. This gives many-track projects (>50 tracks) a
    // responsive UI: a single rebuildTrackPrefetch costs ~0.2–1.5 ms
    // depending on the BufferingAudioSource state, so we get ~3–10
    // tracks per tick instead of the previous one-track-per-10ms
    // (i.e. 50 tracks = 500 ms instead of 50–150 ms).
    //
    // Also called from `setPositionMs` while playing — see comment
    // there. The budgeted form is correct whether the transport is
    // playing or paused.
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
        // Check if there's anything left after the budget cutoff.
        for (auto& [id, track] : tracks)
        {
            if (track->prefetchDirty)
            {
                rebuildTimer.startTimer(kFollowupMs);
                return;
            }
        }
    }

    // The rebuild has fully settled. After a paused seek, deep block-prime the
    // read-ahead at the new playhead so the first play lands on a buffer hit
    // rather than the cold-cache underrun that otherwise swallows the first
    // ~two plays (cold MP3 decode + warp across tracks sharing one read-ahead
    // thread). This mirrors the load-time prewarm and reuses the same routine.
    // Scoped to seeks (pendingSeekPrewarm) so paused clip edits never pay it,
    // and skipped while playing — audio already flows and the message thread
    // must never stall mid-playback. Bounded by kLoadPrimeBudgetMs so a cold
    // seek can never wedge the thread; the warm case returns in well under a
    // millisecond. This is a latency optimisation only: play() stays the
    // fail-closed correctness gate and re-primes regardless of this result.
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
