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
    const bool playing = master.isPlaying();
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource == nullptr) continue;
        track->transportSource->setPosition(trackSeekSecondsFor(*track, masterSamples));
        // A short clip whose transport already played to EOF earlier in this playback has
        // auto-stopped (AudioTransportSource clears `playing` at EOF). Repositioning alone does
        // NOT clear that state, so a backward seek *while playing* (e.g. looping back to replay)
        // would leave such clips silent for the rest of the pass. play()'s primeTracksForPlayback
        // restarts transports, but a mid-playback seek bypasses it — so restart here too.
        // start() is idempotent for an already-playing transport. While paused the master gates
        // all output and the next play() re-primes, so only the playing case needs this.
        if (playing) track->transportSource->start();
        track->prefetchDirty = true;
    }
    rebuildTimer.startTimer(playing ? 1 : kRebuildDebounceMs);
    if (! playing)
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

    scheduleTrackPrefetchAfterEdit(*track);

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

    scheduleTrackPrefetchAfterEdit(*track);

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

    silverdaw::log::info("engine",
                         "setClipEnvelope id=" + clipId.toStdString() + " " +
                             snapshot->describe().toStdString() +
                             " published=" + (published != nullptr ? "1" : "0") +
                             " playing=" + (master.isPlaying() ? "1" : "0"));

    // Retire replaced snapshots/processors until the audio thread is quiescent.
    track->offsetSource->setEnvelopeSnapshot(published);
    if (track->envelopeSnapshot != nullptr)
    {
        track->retiredEnvelopes.push_back(std::move(track->envelopeSnapshot));
    }
    track->envelopeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;

    // The envelope is applied upstream of the JUCE read-ahead buffer, so already-buffered samples
    // carry the old gain. Rebuild the prefetch so the new envelope is audible from the first
    // played block rather than only after the stale buffer drains.
    scheduleTrackPrefetchAfterEdit(*track);
    return true;
}

bool AudioEngine::setClipReversed(const juce::String& clipId, bool reversed)
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

    silverdaw::log::info("engine",
                         "setClipReversed id=" + clipId.toStdString() +
                             " reversed=" + (reversed ? "1" : "0") +
                             " playing=" + (master.isPlaying() ? "1" : "0"));

    track->offsetSource->setReversed(reversed);
    // Reversal is applied upstream of the JUCE read-ahead buffer, so already-buffered samples
    // carry the old direction. Rebuild the prefetch so the change is audible from the first
    // played block rather than only after the stale buffer drains.
    scheduleTrackPrefetchAfterEdit(*track);
    return true;
}

bool AudioEngine::setClipEdgeFade(const juce::String& clipId,
                                  bool hasFadeIn, double fadeInStartMs, double fadeInEndMs,
                                  bool hasFadeOut, double fadeOutStartMs, double fadeOutEndMs,
                                  EdgeFadeCurve fadeInCurve, EdgeFadeCurve fadeOutCurve)
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
        hasFadeOut, toSamples(fadeOutStartMs), toSamples(fadeOutEndMs),
        fadeInCurve, fadeOutCurve);
    const EdgeFadeSnapshot* published =
        (snapshot != nullptr && !snapshot->isEmpty()) ? snapshot.get() : nullptr;

    track->offsetSource->setEdgeFadeSnapshot(published);
    if (track->edgeFadeSnapshot != nullptr)
    {
        track->retiredEdgeFades.push_back(std::move(track->edgeFadeSnapshot));
    }
    track->edgeFadeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;

    // The edge fade is applied upstream of the JUCE read-ahead buffer, so already-buffered samples
    // carry the old shape. Rebuild the prefetch so the new fade is audible from the first played
    // block rather than only after the stale buffer drains.
    scheduleTrackPrefetchAfterEdit(*track);
    return true;
}

void AudioEngine::setBrakeDefaults(double seconds, double curve)
{
    brakeDefaultSeconds = juce::jmax(0.0, seconds);
    brakeDefaultCurve = juce::jlimit(BrakeSnapshot::kMinCurvePower, BrakeSnapshot::kMaxCurvePower, curve);

    silverdaw::log::info("engine",
                         "setBrakeDefaults seconds=" + std::to_string(brakeDefaultSeconds) +
                             " curve=" + std::to_string(brakeDefaultCurve));

    for (const auto& [clipId, track] : tracks)
    {
        if (track != nullptr && track->brakeSnapshot != nullptr)
        {
            setClipBrake(clipId, brakeDefaultSeconds, brakeDefaultCurve);
        }
    }

    if (preview.brakeSnapshot != nullptr)
    {
        setPreviewBrake(brakeDefaultSeconds, brakeDefaultCurve);
    }
}

void AudioEngine::setBackspinDefaults(double seconds, double speed, double curve)
{
    backspinDefaultSeconds = juce::jmax(0.0, seconds);
    backspinDefaultSpeed = juce::jlimit(BackspinSnapshot::kMinSpinSpeed, BackspinSnapshot::kMaxSpinSpeed, speed);
    backspinDefaultCurve = juce::jlimit(BackspinSnapshot::kMinCurvePower, BackspinSnapshot::kMaxCurvePower, curve);

    silverdaw::log::info("engine",
                         "setBackspinDefaults seconds=" + std::to_string(backspinDefaultSeconds) +
                             " speed=" + std::to_string(backspinDefaultSpeed) +
                             " curve=" + std::to_string(backspinDefaultCurve));

    for (const auto& [clipId, track] : tracks)
    {
        if (track != nullptr && track->backspinSnapshot != nullptr)
        {
            setClipBackspin(clipId, backspinDefaultSeconds, backspinDefaultSpeed, backspinDefaultCurve);
        }
    }

    if (preview.backspinSnapshot != nullptr)
    {
        setPreviewBackspin(backspinDefaultSeconds, backspinDefaultSpeed, backspinDefaultCurve);
    }
}

bool AudioEngine::setClipBrake(const juce::String& clipId, double brakeSeconds, double curvePower)
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
    const auto brakeLenSamples =
        static_cast<juce::int64>(juce::jmax(0.0, brakeSeconds) * sr);

    silverdaw::log::info("engine",
                         "setClipBrake id=" + clipId.toStdString() +
                             " seconds=" + std::to_string(brakeSeconds) +
                             " samples=" + std::to_string(brakeLenSamples) +
                             " playing=" + (master.isPlaying() ? "1" : "0"));

    auto snapshot = BrakeSnapshot::create(brakeLenSamples, curvePower);
    const BrakeSnapshot* published =
        (snapshot != nullptr && !snapshot->isEmpty()) ? snapshot.get() : nullptr;

    if (published != nullptr)
    {
        track->offsetSource->setBackspinSnapshot(nullptr);
        if (track->backspinSnapshot != nullptr)
        {
            track->retiredBackspins.push_back(std::move(track->backspinSnapshot));
        }
    }

    track->offsetSource->setBrakeSnapshot(published);
    if (track->brakeSnapshot != nullptr)
    {
        track->retiredBrakes.push_back(std::move(track->brakeSnapshot));
    }
    track->brakeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;

    // The brake is applied upstream of the JUCE read-ahead buffer, so already-buffered samples
    // carry the old direction/rate. Rebuild the prefetch so the change is audible from the first
    // played block rather than only after the stale buffer drains.
    scheduleTrackPrefetchAfterEdit(*track);
    return true;
}

bool AudioEngine::setClipBackspin(const juce::String& clipId, double backspinSeconds,
                                  double spinSpeed, double curvePower)
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
    const auto backspinLenSamples =
        static_cast<juce::int64>(juce::jmax(0.0, backspinSeconds) * sr);

    silverdaw::log::info("engine",
                         "setClipBackspin id=" + clipId.toStdString() +
                             " seconds=" + std::to_string(backspinSeconds) +
                             " samples=" + std::to_string(backspinLenSamples) +
                             " speed=" + std::to_string(spinSpeed) +
                             " curve=" + std::to_string(curvePower) +
                             " playing=" + (master.isPlaying() ? "1" : "0"));

    auto snapshot = BackspinSnapshot::create(backspinLenSamples, spinSpeed, curvePower);
    const BackspinSnapshot* published =
        (snapshot != nullptr && !snapshot->isEmpty()) ? snapshot.get() : nullptr;

    if (published != nullptr)
    {
        track->offsetSource->setBrakeSnapshot(nullptr);
        if (track->brakeSnapshot != nullptr)
        {
            track->retiredBrakes.push_back(std::move(track->brakeSnapshot));
        }
    }

    track->offsetSource->setBackspinSnapshot(published);
    if (track->backspinSnapshot != nullptr)
    {
        track->retiredBackspins.push_back(std::move(track->backspinSnapshot));
    }
    track->backspinSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;

    scheduleTrackPrefetchAfterEdit(*track);
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
        track->warpMode = {};
        scheduleTrackPrefetchAfterEdit(*track);
        silverdaw::log::info("engine", "clip warp disabled " + clipId);
        return true;
    }

    if (!WarpProcessor::supportsChannelCount(track->numChannels))
    {
        silverdaw::log::warn(
            "engine",
            "clip warp rejected " + clipId + ": source has "
                + juce::String(track->numChannels) + " channels");
        return false;
    }

    // Silverdaw tempoRatio is project/source; Rubber Band receives the inverse internally.
    // Only rebuild the stretcher when there is none yet or the mode actually changes — a rebuild
    // is a heavy alloc that resets the stretcher's history (an audible glitch mid-playback), so
    // ratio/pitch-only changes and same-state replays (e.g. incremental undo) must reuse it.
    const auto modeStr = mode.value_or(track->warpMode.isEmpty() ? juce::String("rhythmic")
                                                                 : track->warpMode);
    const bool needRebuild = (track->warp == nullptr) || (mode.has_value() && modeStr != track->warpMode);
    if (needRebuild)
    {
        const auto& dm = deviceManager.getAudioDeviceSetup();
        auto wp = makeWarpProcessor(track->numChannels, track->sampleRate,
                                    static_cast<int>(dm.bufferSize), modeStr,
                                    tempoRatio, semitones, cents);
        if (track->warp != nullptr)
        {
            track->retiredWarps.push_back(std::move(track->warp));
        }
        track->warp = std::move(wp);
        track->warpMode = modeStr;
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

    scheduleTrackPrefetchAfterEdit(*track);
    return true;
}

bool AudioEngine::canWarpClip(const juce::String& clipId) const noexcept
{
    const auto it = tracks.find(clipId);
    return it != tracks.end()
        && WarpProcessor::supportsChannelCount(it->second->numChannels);
}

} // namespace silverdaw
