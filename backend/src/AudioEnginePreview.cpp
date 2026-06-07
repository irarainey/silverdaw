#include "AudioEngine.h"
#include "AudioConstants.h"
#include "AudioEngineWarpFactory.h"
#include "Log.h"

#include <cmath>

namespace silverdaw
{
// -----------------------------------------------------------------------------
// Preview voice
// -----------------------------------------------------------------------------

bool AudioEngine::loadPreview(const juce::File& filePath, double inMs, double durationMs,
                              juce::String* outError,
                              std::optional<bool> initialWarpEnabled,
                              std::optional<juce::String> initialWarpMode,
                              std::optional<double> initialTempoRatio,
                              std::optional<double> initialSemitones,
                              std::optional<double> initialCents)
{
    // Always start from a clean slate. unloadPreview() handles the case
    // where nothing is currently loaded.
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
    // Match the per-track readahead size (8192) rather than the JUCE
    // default 32768. The bigger buffer was inherited from an earlier
    // no-warp preview path; with Rubber Band stretching in the chain,
    // a 32k-sample readahead on a single background reader thread can
    // underrun visibly when the user is auditioning warped material
    // (audible as a "stuttered/chopped" playback). Tracks have always
    // used 8192 with warp and play cleanly, so align preview with the
    // proven track-side discipline. ~85ms at 96kHz, still well above
    // the audio block size.
    preview.transportSource->setSource(preview.offsetSource.get(),
                                       /*readAheadBufferSize=*/kTransportReadAheadSamples,
                                       &readAheadThread, preview.sampleRate);
    preview.transportSource->setPosition(0.0);

    topMixer.addInputSource(preview.transportSource.get(), false);
    previewGeneration.fetch_add(1, std::memory_order_acq_rel);
    silverdaw::log::info("preview", "loaded " + filePath.getFullPathName().toStdString()
                                        + " inMs=" + std::to_string(preview.inMs)
                                        + " durationMs=" + std::to_string(preview.durationMs));
    return true;
}

void AudioEngine::unloadPreview()
{
    // Abandon any in-flight wake pre-roll first: its deferred start would
    // otherwise fire against a torn-down or replaced preview transport (e.g.
    // loadPreview() unloads the old clip mid-pre-roll), starting a clip the
    // user never asked to play.
    cancelWakePreroll();
    if (preview.transportSource == nullptr) return;
    preview.transportSource->stop();
    topMixer.removeInputSource(preview.transportSource.get());
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
    preview.readerSource.reset();
    preview.inMs = 0.0;
    preview.durationMs = 0.0;
    preview.sourceDurationMs = 0.0;
    preview.warpMode = "rhythmic";
    previewGeneration.fetch_add(1, std::memory_order_acq_rel);
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
        return true;
    }
    const juce::String requestedMode = mode.has_value() ? *mode : preview.warpMode;
    const bool needRebuild = (preview.warp == nullptr) || (requestedMode != preview.warpMode);
    if (needRebuild)
    {
        const int channels = preview.readerSource ? preview.readerSource->getAudioFormatReader()->numChannels : 2;
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
    return true;
}

bool AudioEngine::setPreviewEnvelope(const juce::Array<juce::var>& points)
{
    if (preview.offsetSource == nullptr) return false;

    // Compile the immutable snapshot off the audio thread; an empty /
    // single-point shape is "no envelope" → publish nullptr. Publish the
    // new pointer (release) BEFORE retiring the old object so the audio
    // thread only ever sees a live snapshot or nullptr — never a freed
    // pointer. Mirrors `setClipEnvelope`.
    auto snapshot = EnvelopeSnapshot::fromVarArray(points);
    const EnvelopeSnapshot* published = snapshot->isEmpty() ? nullptr : snapshot.get();
    preview.offsetSource->setEnvelopeSnapshot(published);
    if (preview.envelopeSnapshot != nullptr)
    {
        preview.retiredEnvelopes.push_back(std::move(preview.envelopeSnapshot));
    }
    preview.envelopeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;
    return true;
}

void AudioEngine::playPreview()
{
    if (preview.transportSource == nullptr) return;
    // If the playhead is at or past the end of the window, restart from 0.
    if (getPreviewPositionMs() >= preview.durationMs - 1.0)
    {
        preview.transportSource->setPosition(0.0);
    }
    // Start now if the endpoint is warm, or after a short wake pre-roll if it
    // may have slept, so a cold preview's first attack isn't swallowed.
    startWithWakePreroll([this]() {
        if (preview.transportSource != nullptr)
            preview.transportSource->start();
    });
}

void AudioEngine::pausePreview()
{
    if (preview.transportSource == nullptr) return;
    lastOutputActiveMs = juce::Time::getMillisecondCounterHiRes();
    cancelWakePreroll();
    preview.transportSource->stop();
}

void AudioEngine::stopPreview()
{
    if (preview.transportSource == nullptr) return;
    lastOutputActiveMs = juce::Time::getMillisecondCounterHiRes();
    cancelWakePreroll();
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

bool AudioEngine::isPreviewLoaded() const
{
    return preview.transportSource != nullptr;
}

juce::int64 AudioEngine::getPreviewGeneration() const
{
    return previewGeneration.load(std::memory_order_acquire);
}
} // namespace silverdaw
