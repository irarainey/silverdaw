#include "AudioEngine.h"
#include "AudioConstants.h"
#include "AudioEngineWarpFactory.h"
#include "Log.h"

#include <cmath>

namespace silverdaw
{

bool AudioEngine::loadPreview(const juce::File& filePath, double inMs, double durationMs,
                              juce::String* outError,
                              std::optional<bool> initialWarpEnabled,
                              std::optional<juce::String> initialWarpMode,
                              std::optional<double> initialTempoRatio,
                              std::optional<double> initialSemitones,
                              std::optional<double> initialCents)
{
    unloadPreview();

    if (!filePath.existsAsFile())
    {
        if (outError != nullptr) *outError = "file does not exist: " + filePath.getFullPathName();
        return false;
    }

    auto* reader = formatManager.createReaderFor(filePath);
    if (reader == nullptr)
    {
        if (outError != nullptr) *outError = "could not decode: " + filePath.getFullPathName();
        return false;
    }
    if (initialWarpEnabled.value_or(false)
        && !WarpProcessor::supportsChannelCount(static_cast<int>(reader->numChannels)))
    {
        if (outError != nullptr)
            *outError = "Warp supports audio with up to "
                      + juce::String(WarpProcessor::kMaxChannels) + " channels";
        delete reader;
        return false;
    }

    preview.sampleRate = reader->sampleRate > 0.0 ? reader->sampleRate : 44100.0;
    preview.sourceDurationMs =
        (static_cast<double>(reader->lengthInSamples) / preview.sampleRate) * 1000.0;
    preview.inMs = juce::jmax(0.0, juce::jmin(inMs, preview.sourceDurationMs));
    const double remaining = juce::jmax(0.0, preview.sourceDurationMs - preview.inMs);
    preview.durationMs = durationMs > 0.0 ? juce::jmin(durationMs, remaining) : remaining;

    preview.readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader, /*deleteReader=*/true);

    preview.offsetSource = std::make_unique<OffsetSource>(preview.readerSource.get());
    preview.offsetSource->setOffsetSamples(0);
    preview.offsetSource->setInSourceSamples(
        static_cast<juce::int64>((preview.inMs / 1000.0) * preview.sampleRate));
    preview.offsetSource->setClipDurationSamples(
        static_cast<juce::int64>((preview.durationMs / 1000.0) * preview.sampleRate));

    if (initialWarpEnabled.value_or(false))
    {
        const auto modeStr = initialWarpMode.value_or(juce::String("rhythmic"));
        preview.warpMode = modeStr;
        const int channels = preview.readerSource ? preview.readerSource->getAudioFormatReader()->numChannels : 2;
        const auto& dm = deviceManager.getAudioDeviceSetup();
        auto wp = makeWarpProcessor(channels, preview.sampleRate,
                                    static_cast<int>(dm.bufferSize), modeStr,
                                    initialTempoRatio, initialSemitones, initialCents);
        [[maybe_unused]] auto oldWarp = std::move(preview.warp);
        preview.warp = std::move(wp);
        preview.offsetSource->setWarpProcessor(preview.warp.get());
        preview.offsetSource->requestWarpReseek();
    }

    preview.transportSource = std::make_unique<juce::AudioTransportSource>();
    // Silverdaw tempoRatio is project/source; Rubber Band receives the inverse internally.
    preview.transportSource->setSource(preview.offsetSource.get(),
                                       /*readAheadBufferSize=*/kTransportReadAheadSamples,
                                       &readAheadThread, preview.sampleRate);
    preview.transportSource->setPosition(0.0);

    // Mix the Clip Editor metronome through a wrapper (added in place of the bare transport) so its
    // lifetime is managed by the mixer's add/remove locking. Re-apply the persisted enabled state
    // and grid so toggling the click survives preview reloads.
    previewMetronomeSource = std::make_unique<PreviewMetronomeSource>(*preview.transportSource, outputKeepAlive);
    previewMetronomeSource->setEnabled(previewMetronomeEnabled);
    previewMetronomeSource->setGrid(previewMetronomeBpm, previewMetronomeAnchorSec);
    updatePreviewMetronomeMapping();
    topMixer.addInputSource(previewMetronomeSource.get(), false);
    preview.sourceFile = filePath;
    previewGeneration.fetch_add(1, std::memory_order_acq_rel);
    silverdaw::log::info("preview", "loaded " + filePath.getFullPathName().toStdString()
                                        + " inMs=" + std::to_string(preview.inMs)
                                        + " durationMs=" + std::to_string(preview.durationMs));
    return true;
}

void AudioEngine::unloadPreview()
{
    if (preview.transportSource == nullptr) return;
    preview.transportSource->stop();
    // Remove the metronome wrapper (the actual mixer input) before tearing down the transport it
    // wraps. removeInputSource synchronises against the audio callback, so no in-flight render can
    // touch the transport afterwards.
    if (previewMetronomeSource != nullptr)
    {
        topMixer.removeInputSource(previewMetronomeSource.get());
        previewMetronomeSource.reset();
    }
    preview.transportSource->setSource(nullptr);
    preview.transportSource.reset();
    if (preview.offsetSource != nullptr)
    {
        preview.offsetSource->setWarpProcessor(nullptr);
    }
    preview.offsetSource.reset();
    preview.warp.reset();
    preview.retiredWarps.clear();
    preview.envelopeSnapshot.reset();
    preview.retiredEnvelopes.clear();
    preview.brakeSnapshot.reset();
    preview.retiredBrakes.clear();
    preview.backspinSnapshot.reset();
    preview.retiredBackspins.clear();
    preview.readerSource.reset();
    preview.sourceFile = juce::File();
    preview.inMs = 0.0;
    preview.durationMs = 0.0;
    preview.sourceDurationMs = 0.0;
    preview.warpMode = "rhythmic";
    previewGeneration.fetch_add(1, std::memory_order_acq_rel);
}

void AudioEngine::releaseReadersForFile(const juce::File& file)
{
    // The preview voice keeps an AudioFormatReaderSource (an open file handle) on its
    // loaded WAV. If that WAV is about to be deleted, tear the preview down first so the
    // handle closes and the file is really removed (not left delete-pending) — otherwise
    // its now-empty per-source folder cannot be removed on Windows. Timeline-clip readers
    // are not considered: the renderer refuses to remove a library item still in use by a
    // clip, so no track holds the file at delete time.
    if (preview.readerSource != nullptr && preview.sourceFile == file)
    {
        silverdaw::log::info("preview",
                             "releasing preview reader before delete: " + file.getFullPathName().toStdString());
        unloadPreview();
    }
}

bool AudioEngine::setPreviewWarp(std::optional<bool> enabled,
                                 std::optional<juce::String> mode,
                                 std::optional<double> tempoRatio,
                                 std::optional<double> semitones,
                                 std::optional<double> cents)
{
    if (preview.offsetSource == nullptr) return false;
    const bool wantEnabled = enabled.value_or(preview.warp != nullptr);
    if (!wantEnabled)
    {
        preview.offsetSource->setWarpProcessor(nullptr);
        if (preview.warp != nullptr) preview.retiredWarps.push_back(std::move(preview.warp));
        updatePreviewMetronomeMapping();
        return true;
    }
    const int channels =
        preview.readerSource ? preview.readerSource->getAudioFormatReader()->numChannels : 2;
    if (!WarpProcessor::supportsChannelCount(channels))
    {
        silverdaw::log::warn(
            "engine",
            "preview warp rejected: source has " + juce::String(channels) + " channels");
        return false;
    }

    const juce::String requestedMode = mode.has_value() ? *mode : preview.warpMode;
    const bool needRebuild = (preview.warp == nullptr) || (requestedMode != preview.warpMode);
    if (needRebuild)
    {
        const auto& dm = deviceManager.getAudioDeviceSetup();
        auto wp = makeWarpProcessor(channels, preview.sampleRate,
                                    static_cast<int>(dm.bufferSize), requestedMode,
                                    tempoRatio, semitones, cents);
        auto oldWarp = std::move(preview.warp);
        preview.warp = std::move(wp);
        preview.warpMode = requestedMode;
        preview.offsetSource->setWarpProcessor(preview.warp.get());
        if (oldWarp != nullptr) preview.retiredWarps.push_back(std::move(oldWarp));
        preview.offsetSource->requestWarpReseek();
        updatePreviewMetronomeMapping();
        return true;
    }
    if (auto* w = preview.warp.get())
    {
        if (tempoRatio.has_value() && *tempoRatio > 0.0) w->setTempoRatio(*tempoRatio);
        if (semitones.has_value() || cents.has_value())
        {
            const double s = semitones.value_or(0.0);
            const double c = cents.value_or(0.0);
            w->setPitchScale(std::pow(2.0, (s + c / 100.0) / 12.0));
        }
    }
    updatePreviewMetronomeMapping();
    return true;
}

bool AudioEngine::setPreviewEnvelope(const juce::Array<juce::var>& points)
{
    if (preview.offsetSource == nullptr) return false;

    auto snapshot = EnvelopeSnapshot::fromVarArray(points);
    const EnvelopeSnapshot* published = snapshot->isEmpty() ? nullptr : snapshot.get();
    const double posBefore =
        preview.transportSource != nullptr ? preview.transportSource->getCurrentPosition() : -1.0;
    silverdaw::log::debug("preview",
                          "setPreviewEnvelope " + snapshot->describe().toStdString() +
                              " published=" + (published != nullptr ? "1" : "0") +
                              " playing=" + (preview.transportSource != nullptr &&
                                                     preview.transportSource->isPlaying()
                                                 ? "1"
                                                 : "0") +
                              " pos=" + juce::String(posBefore, 3).toStdString());
    preview.offsetSource->setEnvelopeSnapshot(published);
    if (preview.envelopeSnapshot != nullptr)
    {
        preview.retiredEnvelopes.push_back(std::move(preview.envelopeSnapshot));
    }
    preview.envelopeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;

    // The volume envelope is applied upstream of the transport's read-ahead buffer, so samples
    // already cached still carry the previous gain. While playing, the read position advances past
    // the cached window within a few ms so the new gain is heard almost immediately and we avoid
    // disturbing the audition. While stopped, the buffer is parked over the play position and a
    // plain seek can't invalidate an already-valid region in place (JUCE only refills once the play
    // position leaves the cached range), so rebuild the read-ahead to force a re-read with the new
    // envelope.
    if (preview.transportSource != nullptr && !preview.transportSource->isPlaying())
    {
        rebuildPreviewReadAhead();
    }
    return true;
}

// Reverse is applied upstream of the read-ahead buffer (inside OffsetSource), exactly like the
// volume envelope, so the same flush rules apply: while stopped the parked buffer must be rebuilt
// to force a re-read; while playing the cached window drains within a few ms.
bool AudioEngine::setPreviewReversed(bool reversed)
{
    if (preview.offsetSource == nullptr) return false;
    preview.offsetSource->setReversed(reversed);
    silverdaw::log::debug("preview", std::string("setPreviewReversed ") + (reversed ? "1" : "0"));
    if (preview.transportSource != nullptr && !preview.transportSource->isPlaying())
    {
        rebuildPreviewReadAhead();
    }
    return true;
}

bool AudioEngine::setPreviewBrake(double brakeSeconds, double curvePower)
{
    if (preview.offsetSource == nullptr) return false;

    const double sr = preview.sampleRate > 0.0 ? preview.sampleRate : 44100.0;
    const auto brakeLenSamples =
        static_cast<juce::int64>(juce::jmax(0.0, brakeSeconds) * sr);

    auto snapshot = BrakeSnapshot::create(brakeLenSamples, curvePower);
    const BrakeSnapshot* published =
        (snapshot != nullptr && !snapshot->isEmpty()) ? snapshot.get() : nullptr;

    if (published != nullptr)
    {
        preview.offsetSource->setBackspinSnapshot(nullptr);
        if (preview.backspinSnapshot != nullptr)
        {
            preview.retiredBackspins.push_back(std::move(preview.backspinSnapshot));
        }
    }

    preview.offsetSource->setBrakeSnapshot(published);
    if (preview.brakeSnapshot != nullptr)
    {
        preview.retiredBrakes.push_back(std::move(preview.brakeSnapshot));
    }
    preview.brakeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;

    silverdaw::log::debug("preview",
                          std::string("setPreviewBrake seconds=") + std::to_string(brakeSeconds));
    if (preview.transportSource != nullptr && !preview.transportSource->isPlaying())
    {
        rebuildPreviewReadAhead();
    }
    return true;
}

bool AudioEngine::setPreviewBackspin(double backspinSeconds, double spinSpeed, double curvePower)
{
    if (preview.offsetSource == nullptr) return false;

    const double sr = preview.sampleRate > 0.0 ? preview.sampleRate : 44100.0;
    const auto backspinLenSamples =
        static_cast<juce::int64>(juce::jmax(0.0, backspinSeconds) * sr);

    auto snapshot = BackspinSnapshot::create(backspinLenSamples, spinSpeed, curvePower);
    const BackspinSnapshot* published =
        (snapshot != nullptr && !snapshot->isEmpty()) ? snapshot.get() : nullptr;

    if (published != nullptr)
    {
        preview.offsetSource->setBrakeSnapshot(nullptr);
        if (preview.brakeSnapshot != nullptr)
        {
            preview.retiredBrakes.push_back(std::move(preview.brakeSnapshot));
        }
    }

    preview.offsetSource->setBackspinSnapshot(published);
    if (preview.backspinSnapshot != nullptr)
    {
        preview.retiredBackspins.push_back(std::move(preview.backspinSnapshot));
    }
    preview.backspinSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;

    silverdaw::log::debug("preview",
                          std::string("setPreviewBackspin seconds=") +
                              std::to_string(backspinSeconds));
    if (preview.transportSource != nullptr && !preview.transportSource->isPlaying())
    {
        rebuildPreviewReadAhead();
    }
    return true;
}

void AudioEngine::rebuildPreviewReadAhead()
{
    if (preview.transportSource == nullptr || preview.offsetSource == nullptr) return;
    const double pos = preview.transportSource->getCurrentPosition();
    preview.transportSource->setSource(nullptr);
    preview.transportSource->setSource(preview.offsetSource.get(),
                                       kTransportReadAheadSamples,
                                       &readAheadThread, preview.sampleRate);
    preview.transportSource->setPosition(pos);
    silverdaw::log::debug("preview",
                          "rebuildPreviewReadAhead pos=" + juce::String(pos, 3).toStdString());
}

void AudioEngine::playPreview()
{
    if (preview.transportSource == nullptr) return;
    if (getPreviewPositionMs() >= preview.durationMs - 1.0)
    {
        preview.transportSource->setPosition(0.0);
    }
    silverdaw::log::info("preview",
                         "playPreview pos=" +
                             juce::String(preview.transportSource->getCurrentPosition(), 3)
                                 .toStdString() +
                             " envelope=" +
                             (preview.envelopeSnapshot != nullptr
                                  ? preview.envelopeSnapshot->describe().toStdString()
                                  : "none"));
    // Sleep-prone (USB) endpoints get the same wake pre-roll as the main transport: the preview's
    // PreviewMetronomeSource wrapper detects this stopped->playing edge on the audio thread and
    // holds the preview silent for a short lead-in while OutputKeepAlive emits its decaying wake
    // burst, rousing a cold/relaxed DAC amp before the first audible sample. Non-sleep-prone
    // endpoints skip it and play instantly. This keeps the Clip Editor / preview window on the
    // exact same device rules as timeline playback.
    preview.transportSource->start();
}

void AudioEngine::pausePreview()
{
    if (preview.transportSource == nullptr) return;
    preview.transportSource->stop();
}

void AudioEngine::stopPreview()
{
    if (preview.transportSource == nullptr) return;
    preview.transportSource->stop();
    preview.transportSource->setPosition(0.0);
}

void AudioEngine::setPreviewPositionMs(double ms)
{
    if (preview.transportSource == nullptr) return;
    const double clamped = juce::jlimit(0.0, juce::jmax(0.0, preview.durationMs), ms);
    const double ratio = preview.warp != nullptr && preview.warp->isActive()
                             ? preview.warp->getTempoRatio()
                             : 1.0;
    preview.transportSource->setPosition((clamped / juce::jmax(1.0e-9, ratio)) / 1000.0);
}

double AudioEngine::getPreviewPositionMs() const
{
    if (preview.transportSource == nullptr) return 0.0;
    const double ratio = preview.warp != nullptr && preview.warp->isActive()
                             ? preview.warp->getTempoRatio()
                             : 1.0;
    return preview.transportSource->getCurrentPosition() * 1000.0 * ratio;
}

double AudioEngine::getPreviewDurationMs() const
{
    return preview.durationMs;
}

bool AudioEngine::isPreviewPlaying() const
{
    return preview.transportSource != nullptr && preview.transportSource->isPlaying();
}

bool AudioEngine::isPreviewFinished() const
{
    return preview.transportSource != nullptr && preview.transportSource->hasStreamFinished();
}

bool AudioEngine::isPreviewLoaded() const
{
    return preview.transportSource != nullptr;
}

juce::int64 AudioEngine::getPreviewGeneration() const
{
    return previewGeneration.load(std::memory_order_acquire);
}

void AudioEngine::updatePreviewMetronomeMapping()
{
    if (previewMetronomeSource == nullptr) return;
    const double ratio = preview.warp != nullptr && preview.warp->isActive()
                             ? preview.warp->getTempoRatio()
                             : 1.0;
    previewMetronomeSource->setClipMapping(preview.inMs, ratio);
}

void AudioEngine::setPreviewMetronomeEnabled(bool enabled)
{
    // A monitoring aid: persisted silently per project (never dirty), applied to the live preview
    // voice when one is loaded and re-applied on the next preview load otherwise.
    previewMetronomeEnabled = enabled;
    if (previewMetronomeSource != nullptr) previewMetronomeSource->setEnabled(enabled);
    silverdaw::log::info("preview", juce::String("clip-editor metronome ") + (enabled ? "on" : "off"));
}

void AudioEngine::setPreviewMetronomeGrid(double bpm, double beatAnchorSec)
{
    previewMetronomeBpm = bpm;
    previewMetronomeAnchorSec = beatAnchorSec;
    if (previewMetronomeSource != nullptr)
    {
        previewMetronomeSource->setGrid(bpm, beatAnchorSec);
        updatePreviewMetronomeMapping();
    }
}
} // namespace silverdaw
