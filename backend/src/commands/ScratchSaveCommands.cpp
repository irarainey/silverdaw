#include "ScratchSaveCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "EditUndoState.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "Waveform.h"
#include "WaveformCommands.h"
#include "scratch/ScratchPatternBake.h"
#include "scratch/ScratchProtocol.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>

#include <memory>

namespace silverdaw
{

using silverdaw::bridge::tryGetRequiredString;
using silverdaw::bridge::tryGetString;

namespace
{

juce::String sanitiseScratchFileName(juce::String name)
{
    name = name.trim();
    if (name.isEmpty()) name = "Scratch";
    static constexpr const char* bad = "<>:\"/\\|?*";
    for (int i = 0; bad[i] != '\0'; ++i)
        name = name.replaceCharacter(bad[i], '_');
    return name.trim().isNotEmpty() ? name.trim() : juce::String("Scratch");
}

// Distinct revision suffix per save so re-saving an existing scratch never
// overwrites a WAV that a placed clip may still be reading; the library item is
// then atomically repointed to the new revision.
juce::File uniqueScratchWav(const juce::File& dir, const juce::String& baseName)
{
    for (int i = 1; i < 10000; ++i)
    {
        auto file = dir.getChildFile(baseName + "-take-" + juce::String(i).paddedLeft('0', 3) + ".wav");
        if (!file.existsAsFile()) return file;
    }
    return dir.getChildFile(baseName + "-take-" + juce::Uuid().toString().substring(0, 8) + ".wav");
}

bool writeBufferToWav(const juce::AudioBuffer<float>& buffer, double sampleRate,
                      const juce::File& outputFile, juce::String& error)
{
    if (buffer.getNumSamples() <= 0 || buffer.getNumChannels() <= 0 || sampleRate <= 0.0)
    {
        error = "Baked scratch has no audio";
        return false;
    }
    if (auto parent = outputFile.getParentDirectory(); !parent.exists() && parent.createDirectory().failed())
    {
        error = "Could not create scratch folder";
        return false;
    }
    outputFile.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> stream(outputFile.createOutputStream());
    if (stream == nullptr)
    {
        error = "Could not create scratch file";
        return false;
    }
    const auto writerOptions = juce::AudioFormatWriterOptions{}
                                   .withSampleRate(sampleRate)
                                   .withNumChannels(buffer.getNumChannels())
                                   .withBitsPerSample(24);
    std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, writerOptions));
    if (writer == nullptr)
    {
        error = "Could not create WAV writer";
        return false;
    }
    // The writer took ownership of the stream on success.
    if (!writer->writeFromAudioSampleBuffer(buffer, 0, buffer.getNumSamples()))
    {
        error = "Could not write scratch audio";
        return false;
    }
    return true;
}

} // namespace

void handleScratchSaveAsSample(const juce::var& payload, AudioEngine& engine,
                               ProjectState& projectState, BridgeServer& bridge,
                               juce::ThreadPool& peakPool, const PeaksCache& cache,
                               const ProjectSession& session)
{
    if (!scratch::hasValidProtocolVersion(payload))
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_SAVE_AS_SAMPLE: bad protocolVersion");
        return;
    }

    const auto patternVar = payload.getProperty("pattern", juce::var());
    if (!patternVar.isObject())
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_SAVE_AS_SAMPLE: missing pattern object");
        return;
    }
    const auto parsed = scratch::parsePattern(patternVar);
    if (!parsed)
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_SAVE_AS_SAMPLE: pattern failed validation");
        return;
    }

    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    if (itemId.isEmpty())
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_SAVE_AS_SAMPLE: missing itemId");
        return;
    }
    const juce::String sampleName =
        tryGetString(payload, "sampleName").value_or(juce::String{}).trim().isNotEmpty()
            ? tryGetString(payload, "sampleName").value_or(juce::String{}).trim()
            : (parsed->name.isNotEmpty() ? parsed->name : juce::String("Scratch"));

    // The library item the scratch was recorded over; the baked sample inherits
    // its media GUID so cover art resolves from the shared project media entry.
    const juce::String sourceItemId = tryGetString(payload, "sourceItemId").value_or(juce::String{});
    const juce::String sampleMediaId =
        sourceItemId.isNotEmpty() ? projectState.getLibraryItemMediaId(sourceItemId) : juce::String{};

    // Persist the canonical notation into the project ValueTree first, so re-open
    // and project save/reload have it even if the bake fails on the worker.
    const bool notationOk = projectState.hasScratchPattern(parsed->id)
                                ? projectState.updateScratchPattern(parsed->id, patternVar)
                                : projectState.addScratchPattern(patternVar);
    if (!notationOk)
    {
        silverdaw::log::warn("scratch",
                             "SCRATCH_SAVE_AS_SAMPLE: notation persist failed id=" + parsed->id);
        return;
    }

    // Grab the immutable prepared source on the message thread; a worker thread
    // may safely read the shared_ptr<const> copy for the offline bake.
    auto preparedSource = engine.getScratchPreparedSource();
    const double sourceSampleRate = engine.getScratchPreparedSourceSampleRate();
    if (!preparedSource || preparedSource->getNumSamples() <= 0 || sourceSampleRate <= 0.0)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("itemId", itemId);
        obj->setProperty("ok", false);
        obj->setProperty("error", "No prepared scratch source to bake");
        bridge.broadcast("SAMPLE_SAVED", juce::var(obj));
        return;
    }

    const auto scratchDir =
        projectArtifactsBaseDir(session.currentPath, "scratches")
            .getChildFile(sanitiseScratchFileName(parsed->id));
    const auto pattern = *parsed;
    const juce::var notationVar = patternVar;

    peakPool.addJob(
        [pattern, notationVar, preparedSource, sourceSampleRate, scratchDir, itemId, sampleName,
         sourceItemId, sampleMediaId, &engine, &projectState, &cache, &bridge, &session]
        {
            const auto safeName = sanitiseScratchFileName(sampleName);
            juce::String error;

            auto baked = scratch::bakePatternToBuffer(pattern, preparedSource, sourceSampleRate);
            const auto bakedFile = uniqueScratchWav(scratchDir, safeName);
            const bool bakeOk =
                baked.getNumSamples() > 0
                    ? writeBufferToWav(baked, sourceSampleRate, bakedFile, error)
                    : (error = "Scratch pattern produced no audio", false);

            // Self-contained source snapshot so the scratch can be re-edited even
            // if the original library item or file is later removed. Written once.
            const auto sourceFile = scratchDir.getChildFile("source.wav");
            if (bakeOk && !sourceFile.existsAsFile())
            {
                juce::String sourceError;
                if (!writeBufferToWav(*preparedSource, sourceSampleRate, sourceFile, sourceError))
                    silverdaw::log::warn("scratch",
                                         "SCRATCH_SAVE_AS_SAMPLE: source snapshot failed: " + sourceError);
            }

            // Generated, read-only artifact mirroring the canonical ValueTree
            // notation for external inspection; never read back as the source of truth.
            if (bakeOk)
            {
                const auto notationFile = scratchDir.getChildFile("notation.json");
                notationFile.replaceWithText(juce::JSON::toString(notationVar));
            }

            silverdaw::waveform::PeaksResult peaks;
            juce::File peaksFile;
            if (bakeOk)
            {
                peaks = silverdaw::waveform::computePeaks(bakedFile, engine.getFormatManager(),
                                                          silverdaw::waveform::kDefaultPeaksPerSecond);
                if (!peaks.peaks.empty())
                {
                    cache.store(bakedFile, peaks);
                    peaksFile = cache.getCacheFilePath(bakedFile, silverdaw::waveform::kDefaultPeaksPerSecond);
                }
            }

            const double durationMs = static_cast<double>(baked.getNumSamples()) * 1000.0
                                    / juce::jmax(1.0, sourceSampleRate);
            const int channels = baked.getNumChannels();
            const juce::String sourcePath = sourceFile.getFullPathName();

            juce::MessageManager::callAsync(
                [pattern, itemId, safeName, bakedFile, durationMs, sourceSampleRate, channels,
                 bakeOk, error, peaks, peaksFile, sourcePath, sourceItemId, sampleMediaId,
                 &projectState, &bridge, &session]
                {
                    auto* obj = new juce::DynamicObject();
                    obj->setProperty("itemId", itemId);
                    const bool ok = bakeOk && !peaks.peaks.empty();
                    obj->setProperty("ok", ok);
                    if (!ok)
                    {
                        obj->setProperty("error",
                                         error.isNotEmpty() ? error
                                                            : juce::String("Could not create scratch peaks"));
                        bridge.broadcast("SAMPLE_SAVED", juce::var(obj));
                        return;
                    }

                    projectState.getUndoManager().beginNewTransaction("Save scratch");
                    // Frozen scratch sample: a plain unanalysed one-shot (kind="sample",
                    // audioType="simple") that still warps/pitch-shifts, plus additive
                    // scratch metadata linking it to its notation + source snapshot for
                    // re-editing. It carries NO live scratchPatternId on placed clips, so
                    // dropping it plays the baked audio directly (never re-scratched).
                    projectState.addLibraryItem(itemId, bakedFile.getFullPathName(), bakedFile.getFileName(),
                                                durationMs, static_cast<int>(sourceSampleRate), channels,
                                                bakedFile.getFullPathName(), {}, "sample", safeName,
                                                sourceItemId, {}, -1.0, -1.0, -1, sampleMediaId);
                    projectState.setLibraryItemAudioType(itemId, "simple");
                    projectState.setLibraryItemScratchMeta(itemId, pattern.id, sourcePath);

                    obj->setProperty("filePath", bakedFile.getFullPathName());
                    obj->setProperty("fileName", bakedFile.getFileName());
                    obj->setProperty("name", safeName);
                    obj->setProperty("durationMs", durationMs);
                    obj->setProperty("sampleRate", sourceSampleRate);
                    obj->setProperty("channelCount", channels);
                    obj->setProperty("cachePath", peaksFile.getFullPathName());
                    obj->setProperty("peakCount", peaks.bucketsPerLane());
                    obj->setProperty("laneCount", peaks.laneCount);
                    obj->setProperty("peaksPerSecond", silverdaw::effectivePeaksPerSecond(peaks));
                    obj->setProperty("audioType", "simple");
                    obj->setProperty("scratchOrigin", true);
                    obj->setProperty("scratchPatternId", pattern.id);
                    obj->setProperty("scratchSourcePath", sourcePath);
                    if (sourceItemId.isNotEmpty())
                        obj->setProperty("sourceItemId", sourceItemId);
                    bridge.broadcast("SAMPLE_SAVED", juce::var(obj));

                    // Full resync carries the notation + additive library metadata so the
                    // renderer can re-open the editor and persist across save/reload.
                    bridge.broadcast("PROJECT_STATE",
                                     silverdaw::buildProjectStateEnvelope(session, projectState, false));
                    silverdaw::broadcastEditUndoState(projectState, bridge);
                    silverdaw::log::info("scratch",
                                         "SCRATCH_SAVE_AS_SAMPLE ok id=" + pattern.id + " item=" + itemId);
                });
        });
}

} // namespace silverdaw
