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

    // Seeking starts the shared Reverb / Delay from cold state — wipe any
    // ringing tail so it doesn't bleed across the jump (§7.10).
    busGraph.resetSharedFx();
    // Per-track seek: also invalidate the read-ahead prefetch. JUCE's
    // `BufferingAudioSource` only flushes its cached samples when the
    // new position is OUTSIDE the cached range, so a backward seek of
    // less than the buffer's worth of audio (~0.7 s at 32 768 samples /
    // 48 kHz) can leave the stale tail in place. The next audio
    // callback would then play a moment of pre-seek audio before the
    // background prefetch catches up — exactly the "doesn't play at
    // the correct position" bug.
    //
    // Path (both playing and paused — unified):
    //   - Mark every track `prefetchDirty` and arm the budgeted timer.
    //     The timer's `flushDirtyRebuilds` runs in time-bounded chunks
    //     so even very many tracks rebuild in a couple of ticks
    //     without ever blocking the message thread for more than
    //     ~2 ms at a time. The transport keeps playing during the
    //     rebuild window; some tracks may briefly emit stale audio
    //     (worst case ~0.7 s) before their fresh prefetch lands, but
    //     that's preferable to a long synchronous stall that would
    //     hold up websocket-message processing, UI redraws and the
    //     next seek the user issues.
    //   - We still call `transportSource->setPosition` immediately on
    //     every track (cheap, correctness-relevant) so the master
    //     position and per-track transport positions stay coherent
    //     for `getPosition`/`getTimeInfo` queries from the UI.
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource == nullptr) continue;
        track->transportSource->setPosition(trackSeekSecondsFor(*track, masterSamples));
        track->prefetchDirty = true;
    }
    // While playing we want the rebuild as soon as possible (single
    // tick); while paused the existing debounce gives drag-seeks a
    // chance to coalesce.
    rebuildTimer.startTimer(master.isPlaying() ? 1 : kRebuildDebounceMs);
    // On a paused seek, arm a one-shot prewarm so the rebuild settle deep-fills
    // the read-ahead at the new playhead — the first play after a seek is then
    // a buffer hit, not a cold-cache underrun. Coalesced by the debounce so
    // scrubbing only primes once the user settles. Not armed while playing
    // (audio already flows; never stall the message thread mid-playback).
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

    // Fast path: lock-free atomic write of the new offset.
    // ────────────────────────────────────────────────────
    // `OffsetSource::offsetSamples` is `std::atomic<int64>`. The next
    // call to `OffsetSource::getNextAudioBlock()` (issued by JUCE's
    // `BufferingAudioSource` background prefetch thread) sees the new
    // value and emits samples for the new offset. No locks, no
    // allocations, no source-chain rebuild.
    //
    // This is the right behaviour for the common case: clip-drag
    // updates while the transport is stopped. The frontend can stream
    // every intermediate position to us during a drag without us
    // having to tear down and rebuild a `BufferingAudioSource` per
    // frame. By the time the user presses Play, the offset has been
    // live for many blocks and any prefetch is already coherent.
    track->offsetSource->setOffsetSamples(newOffsetSamples);
    track->offsetSource->requestWarpReseek();

    if (master.isPlaying())
    {
        // Mid-playback move: rebuild now so the next block the device
        // pulls is at the new offset. Defer-rebuild isn't viable here
        // because audio is being produced live; the listener would
        // otherwise hear the stale ~0.7 s of pre-move audio.
        rebuildTrackPrefetch(*track);
    }
    else
    {
        // Paused move: mark dirty and arm the debounce timer. Each new
        // setClipOffsetMs call restarts the timer, so a rapid drag
        // collapses to a single rebuild ~150 ms after the user releases.
        // By the time they click Play the rebuilt BufferingAudioSource
        // has had time to fill its ring, and `play()` is just a master
        // gate flip — no synchronous rebuild on the play click.
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

    // Atomic writes — `setClipWindowAtomic` bumps a seqlock around
    // the three field writes so the audio thread sees all three
    // values as one snapshot (drag-trim updates them together and
    // the old per-field setters could be observed half-applied,
    // briefly producing audio with a new offset but the old
    // duration / inSource).
    track->offsetSource->setClipWindowAtomic(offsetSamples, inSampleOffset, durSamples);

    // Same rebuild discipline as `setClipOffsetMs`: during playback we
    // must drop the stale prefetch; while paused we debounce.
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

    // Compile the immutable snapshot off the audio thread. An empty /
    // single-point shape is treated as "no envelope" — publish nullptr.
    auto snapshot = EnvelopeSnapshot::fromVarArray(points);
    const EnvelopeSnapshot* published = snapshot->isEmpty() ? nullptr : snapshot.get();

    // Publish the new pointer (release) BEFORE retiring the old object,
    // so the audio thread either sees the previous snapshot (still alive
    // in `retiredEnvelopes`) or the new one — never a freed pointer.
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

    // Convert the master-timeline ms spans to the clip's source-sample clock
    // with the SAME factor `addClip`/`setClipTrim` use for the offset, so the
    // fade bounds align exactly with the samples the audio thread renders.
    const double sr = track->sampleRate > 0.0 ? track->sampleRate : 44100.0;
    const auto toSamples = [sr](double ms) {
        return static_cast<juce::int64>(juce::jmax(0.0, ms) * sr / 1000.0);
    };

    auto snapshot = EdgeFadeSnapshot::create(
        hasFadeIn, toSamples(fadeInStartMs), toSamples(fadeInEndMs),
        hasFadeOut, toSamples(fadeOutStartMs), toSamples(fadeOutEndMs));
    const EdgeFadeSnapshot* published =
        (snapshot != nullptr && !snapshot->isEmpty()) ? snapshot.get() : nullptr;

    // Publish (release) BEFORE retiring the old object so the audio thread
    // sees either the new pointer or the still-alive previous one (held in
    // `retiredEdgeFades` until a quiescent drain), never a freed pointer.
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
        // Disable / teardown. The audio thread sees nullptr via
        // `setWarpProcessor(nullptr)` on the next read, after which
        // the WarpProcessor is logically retired — but the audio
        // thread may still be inside `pullThroughWarp` having just
        // loaded the raw pointer before the swap. We move the old
        // unique_ptr into `retiredWarps` (drained on track unload
        // when the audio thread is quiescent) instead of destroying
        // it immediately; otherwise we have a use-after-free window
        // on the audio thread.
        track->offsetSource->setWarpProcessor(nullptr);
        if (track->warp != nullptr)
        {
            track->retiredWarps.push_back(std::move(track->warp));
        }
        // B3: disabling warp changes the timeline-to-source mapping
        // (no more tempo stretch), so any prefetched audio in the
        // BufferingAudioSource is now at the wrong position. Match
        // the rebuild path's discipline: rebuild immediately while
        // playing, debounce while paused. Without this, disabling
        // warp during playback let the listener hear up to ~0.7 s
        // of stale warp-output before the prefetch caught up.
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

    // Enable / configure. If we already have a processor and the mode
    // wasn't explicitly changed, just push the new parameters to it
    // via its atomic publishers (no allocation, no audio glitch). If
    // the mode IS changing — Rubber Band can't switch engines on a
    // live instance — we tear down and rebuild.
    const bool needRebuild = (track->warp == nullptr) || mode.has_value();
    if (needRebuild)
    {
        const auto modeStr = mode.value_or(juce::String("rhythmic"));
        const auto& dm = deviceManager.getAudioDeviceSetup();
        auto wp = makeWarpProcessor(track->numChannels, track->sampleRate,
                                    static_cast<int>(dm.bufferSize), modeStr,
                                    tempoRatio, semitones, cents);
        // Retire the previous processor (if any) into the deferred
        // free-list rather than destroying it inline — the audio
        // thread may still be holding the raw pointer it loaded
        // from `OffsetSource::warp` just before the swap below.
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

    // Whether we built a fresh processor or just nudged its parameters,
    // the BufferingAudioSource's read-ahead may now hold ~186 ms of
    // audio prefetched through the OLD warp settings (or no warp at
    // all). Drop it: a play-from-cold pull would otherwise serve a
    // few hundred ms of stale audio before the fresh prefetch caught
    // up — heard as a noticeable discontinuity at the very start of
    // playback. Use the same rebuild discipline as `setClipOffsetMs`
    // — sync rebuild while playing, debounced while paused.
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
