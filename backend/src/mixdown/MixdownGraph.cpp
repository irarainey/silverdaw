#include "MixdownGraph.h"

#include "Log.h"

#include <cmath>

namespace silverdaw
{
namespace mixdown_graph
{

/**
 * Build one OfflineClip from the snapshot entry. Returns nullptr on failure
 * (the caller decides how to surface that). `formatManager` must outlive the
 * returned clip.
 */
std::unique_ptr<OfflineClip> buildOfflineClip(const MixdownSnapshot::ClipSnapshot& clip,
                                              const juce::String& trackId,
                                              float trackGain,
                                              int projectSampleRate,
                                              juce::AudioFormatManager& formatManager,
                                              juce::String& outError)
{
    auto out = std::make_unique<OfflineClip>();
    out->id = clip.id;
    out->trackId = trackId;
    out->trackGain = trackGain;

    const juce::File sourceFile(clip.filePath);
    auto* reader = formatManager.createReaderFor(sourceFile);
    if (reader == nullptr)
    {
        outError = "createReaderFor failed for clip " + clip.id + " path=" + clip.filePath;
        return nullptr;
    }
    out->sourceRate = reader->sampleRate;
    out->sourceChannels = juce::jmax(1, static_cast<int>(reader->numChannels));
    const auto readerLengthSamples = reader->lengthInSamples;
    const auto sourceExt = sourceFile.getFileExtension().toLowerCase();
    if (out->sourceRate <= 0.0)
    {
        outError = "Source sample rate is zero for clip " + clip.id;
        delete reader;
        return nullptr;
    }

    // ReaderSource takes ownership of the reader (deleteWhenRemoved=true).
    out->readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader, true);

    // OffsetSource positions are SOURCE-rate frames — identical convention
    // to AudioEngine::addClip. AudioTransportSource's internal resampler
    // maps render-rate (projectRate) cursors back to source-rate cursors,
    // so the offset/in/duration we set here are observed correctly when
    // the transport advances.
    out->offsetSource = std::make_unique<OffsetSource>(out->readerSource.get());
    out->offsetSource->setOffsetSamples(
        static_cast<juce::int64>(clip.offsetMs * out->sourceRate / 1000.0));
    out->offsetSource->setInSourceSamples(
        static_cast<juce::int64>(clip.inMs * out->sourceRate / 1000.0));
    out->offsetSource->setClipDurationSamples(
        static_cast<juce::int64>(clip.durationMs * out->sourceRate / 1000.0));
    // Volume shape runs inside the same OffsetSource as the live engine
    // (post-warp, pre-transport-resample), so the export carries the
    // identical envelope the user hears. Empty point list => no shape.
    out->envelopeSnapshot = EnvelopeSnapshot::fromVarArray(clip.envelopePoints);
    if (out->envelopeSnapshot != nullptr && !out->envelopeSnapshot->isEmpty())
    {
        out->offsetSource->setEnvelopeSnapshot(out->envelopeSnapshot.get());
    }

    // §12.1 transition edge-fade — applied inside the SAME OffsetSource stage
    // as live (post-warp, pre-transport-resample), so the export crossfades
    // identically. Master-timeline ms convert to source-rate frames with the
    // same factor as the offset/in/duration above. No transition => no shape.
    if (clip.edgeFadeIn || clip.edgeFadeOut)
    {
        const auto toSrc = [&](double ms) {
            return static_cast<juce::int64>(juce::jmax(0.0, ms) * out->sourceRate / 1000.0);
        };
        out->edgeFadeSnapshot = EdgeFadeSnapshot::create(
            clip.edgeFadeIn, toSrc(clip.edgeFadeInStartMs), toSrc(clip.edgeFadeInEndMs),
            clip.edgeFadeOut, toSrc(clip.edgeFadeOutStartMs), toSrc(clip.edgeFadeOutEndMs));
        if (out->edgeFadeSnapshot != nullptr && !out->edgeFadeSnapshot->isEmpty())
        {
            out->offsetSource->setEdgeFadeSnapshot(out->edgeFadeSnapshot.get());
        }
    }

    if (clip.warpEnabled)
    {
        // Same constructor invocation pattern as AudioEngine::makeWarpProcessor.
        // WarpProcessor is at SOURCE rate so its priming, start-delay and
        // transient analysis windows are identical to live.
        out->warp = std::make_unique<WarpProcessor>(out->sourceChannels,
                                                    out->sourceRate,
                                                    parseWarpMode(clip.warpMode));
        out->warp->prepareToPlay(kBlockFrames);
        if (clip.tempoRatio > 0.0) out->warp->setTempoRatio(clip.tempoRatio);
        const double pitchScale =
            std::pow(2.0, (clip.semitones + (clip.cents / 100.0)) / 12.0);
        out->warp->setPitchScale(pitchScale);
        out->offsetSource->setWarpProcessor(out->warp.get());
        out->offsetSource->requestWarpReseek();
    }

    out->transport = std::make_unique<juce::AudioTransportSource>();
    // readAhead=0, no background thread — offline rendering wants
    // deterministic synchronous reads. The transport still gets the
    // sourceSampleRateToCorrectFor argument so JUCE inserts its
    // internal ResamplingAudioSource between OffsetSource (source rate)
    // and us (project rate).
    out->transport->setSource(out->offsetSource.get(),
                              0, nullptr,
                              out->sourceRate, out->sourceChannels);
    out->transport->prepareToPlay(kBlockFrames, static_cast<double>(projectSampleRate));
    out->transport->setPosition(0.0);
    out->transport->start();

    // Per-clip summing adapter for `BusGraph::TrackRuntime`
    // attachment (Phase 5 step 1d). Wraps the transport with mono→
    // stereo duplication and constant `trackGain` multiplication
    // (bit-equivalent to the pre-1d `mixClipBlock` summing path).
    out->summingSource = std::make_unique<ClipSummingSource>(
        out->transport.get(), trackGain, out->sourceChannels);
    // Compute timeline end in projectRate frames so the pump loop can
    // retire the clip when its window closes.
    const double endMs = clipTimelineEndMs(clip);
    out->timelineEndFrames =
        static_cast<juce::int64>(std::ceil(endMs * static_cast<double>(projectSampleRate) / 1000.0));

    silverdaw::log::info(
        "mixdown",
        "offline clip built id=" + clip.id +
            " openedPath=" + clip.filePath +
            " ext=" + sourceExt +
            " readerSampleRate=" + juce::String(out->sourceRate, 1) +
            " readerChannels=" + juce::String(out->sourceChannels) +
            " readerLengthSamples=" + juce::String(readerLengthSamples) +
            " libSampleRate=" + juce::String(clip.sourceSampleRate) +
            " libChannels=" + juce::String(clip.sourceChannelCount) +
            " sampleRateMismatch=" +
                ((clip.sourceSampleRate > 0
                  && std::abs(out->sourceRate - static_cast<double>(clip.sourceSampleRate)) > 0.5)
                     ? juce::String("true")
                     : juce::String("false")) +
            " offsetMs=" + juce::String(clip.offsetMs, 1) +
            " inMs=" + juce::String(clip.inMs, 1) +
            " durationMs=" + juce::String(clip.durationMs, 1) +
            " trackGain=" + juce::String(trackGain, 4) +
            " warp=" + (clip.warpEnabled ? juce::String("on") : juce::String("off")) +
            (clip.warpEnabled ? (" tempoRatio=" + juce::String(clip.tempoRatio, 4) +
                                  " effDurationMs=" + juce::String(clip.effectiveDurationMs, 1) +
                                  " mode=" + clip.warpMode +
                                  " semitones=" + juce::String(clip.semitones, 2) +
                                  " cents=" + juce::String(clip.cents, 2))
                              : juce::String()));
    return out;
}

} // namespace mixdown_graph
} // namespace silverdaw
