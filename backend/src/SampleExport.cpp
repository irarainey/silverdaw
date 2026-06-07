#include "SampleExport.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "EditUndoState.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectState.h"
#include "WarpProcessor.h"
#include "Waveform.h"
#include "WaveformCommands.h"

#include <juce_events/juce_events.h>

#include <cmath>
#include <optional>
#include <vector>

namespace silverdaw
{

using silverdaw::bridge::tryGetRequiredString;

namespace
{

juce::String sanitiseSampleFileName(juce::String name)
{
    name = name.trim();
    if (name.isEmpty()) name = "Sample";
    if (name.endsWithIgnoreCase(" sample")) name = name.dropLastCharacters(7).trim();
    static constexpr const char* bad = "<>:\"/\\|?*";
    for (int i = 0; bad[i] != '\0'; ++i)
        name = name.replaceCharacter(bad[i], '_');
    return name.trim().isNotEmpty() ? name.trim() : juce::String("Sample");
}

juce::File uniqueWavFile(const juce::File& dir, const juce::String& baseName)
{
    for (int i = 1; i < 10000; ++i)
    {
        const auto suffix = "-sample-" + juce::String(i).paddedLeft('0', 3);
        auto file = dir.getChildFile(baseName + suffix + ".wav");
        if (!file.existsAsFile()) return file;
    }
    return dir.getChildFile(baseName + "-sample-" + juce::Uuid().toString().substring(0, 8) + ".wav");
}

RubberBand::RubberBandStretcher::Options sampleWarpModeOptions(const juce::String& mode)
{
    return silverdaw::parseWarpMode(mode);
}

struct SampleWarpOptions
{
    bool enabled = false;
    juce::String mode = "rhythmic";
    double tempoRatio = 1.0;
    double semitones = 0.0;
    double cents = 0.0;
};

double pitchScaleFor(double semitones, double cents)
{
    return std::pow(2.0, (semitones + cents / 100.0) / 12.0);
}

bool writeSourceWindowToWav(const juce::File& sourceFile, const juce::File& outputFile,
                            double inMs, double durationMs, silverdaw::AudioEngine& engine,
                            double& outDurationMs, double& outSampleRate, int& outChannels,
                            juce::String& error, const std::optional<SampleWarpOptions>& warpOptions = std::nullopt)
{
    std::unique_ptr<juce::AudioFormatReader> reader(engine.getFormatManager().createReaderFor(sourceFile));
    if (reader == nullptr)
    {
        if (auto stream = sourceFile.createInputStream())
            reader.reset(engine.getFormatManager().createReaderFor(std::move(stream)));
    }
    if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0)
    {
        error = "Could not decode source file";
        return false;
    }

    outSampleRate = reader->sampleRate;
    outChannels = juce::jmax(1, static_cast<int>(reader->numChannels));
    const auto startSample = juce::jlimit(
        static_cast<juce::int64>(0),
        reader->lengthInSamples,
        static_cast<juce::int64>((juce::jmax(0.0, inMs) * reader->sampleRate) / 1000.0));
    const auto available = reader->lengthInSamples - startSample;
    const auto requested =
        durationMs > 0.0
            ? static_cast<juce::int64>((durationMs * reader->sampleRate) / 1000.0)
            : available;
    const auto samplesToWrite = juce::jlimit(static_cast<juce::int64>(0), available, requested);
    if (samplesToWrite <= 0)
    {
        error = "Clip has no audio to export";
        return false;
    }

    if (auto parent = outputFile.getParentDirectory(); !parent.exists() && parent.createDirectory().failed())
    {
        error = "Could not create sample folder";
        return false;
    }
    outputFile.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::FileOutputStream> stream(outputFile.createOutputStream());
    if (stream == nullptr)
    {
        error = "Could not create sample file";
        return false;
    }
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wav.createWriterFor(stream.release(), reader->sampleRate,
                            static_cast<unsigned int>(outChannels), 24, {}, 0));
    if (writer == nullptr)
    {
        error = "Could not create WAV writer";
        return false;
    }

    constexpr int kBlock = 8192;
    juce::AudioBuffer<float> buffer(outChannels, kBlock);
    std::vector<float*> outputPtrs(static_cast<std::size_t>(outChannels));
    const bool renderWarped =
        warpOptions.has_value() &&
        warpOptions->enabled &&
        (std::abs(warpOptions->tempoRatio - 1.0) > 1e-4 ||
         std::abs(pitchScaleFor(warpOptions->semitones, warpOptions->cents) - 1.0) > 1e-4);

    if (renderWarped)
    {
        silverdaw::WarpProcessor warp(outChannels, reader->sampleRate, sampleWarpModeOptions(warpOptions->mode));
        warp.prepareToPlay(kBlock);
        warp.setTempoRatio(warpOptions->tempoRatio);
        warp.setPitchScale(pitchScaleFor(warpOptions->semitones, warpOptions->cents));
        warp.seekSource(startSample);

        const auto outSamples = silverdaw::WarpProcessor::timelineSamplesForSourceSamples(
            samplesToWrite, warpOptions->tempoRatio);
        juce::int64 written = 0;
        const auto sourceEnd = startSample + samplesToWrite;
        while (written < outSamples)
        {
            const int n = static_cast<int>(juce::jmin(static_cast<juce::int64>(kBlock), outSamples - written));
            buffer.clear();
            for (int c = 0; c < outChannels; ++c) outputPtrs[static_cast<std::size_t>(c)] = buffer.getWritePointer(c);
            warp.process(outputPtrs.data(), n,
                         [&](float* const* dest, juce::int64 srcPos, int sourceN)
                         {
                             juce::AudioBuffer<float> srcView(const_cast<float**>(dest), outChannels, sourceN);
                             srcView.clear();
                             const auto readStart = juce::jmax(srcPos, startSample);
                             const auto readEnd = juce::jmin(srcPos + sourceN, sourceEnd);
                             if (readEnd <= readStart) return;
                             const int destOffset = static_cast<int>(readStart - srcPos);
                             const int count = static_cast<int>(readEnd - readStart);
                             reader->read(&srcView, destOffset, count, readStart, true, true);
                         });
            if (!writer->writeFromAudioSampleBuffer(buffer, 0, n))
            {
                error = "Could not write warped sample audio";
                return false;
            }
            written += n;
        }
        outDurationMs = static_cast<double>(outSamples) * 1000.0 / reader->sampleRate;
        return true;
    }

    juce::int64 written = 0;
    while (written < samplesToWrite)
    {
        const int n = static_cast<int>(juce::jmin(static_cast<juce::int64>(kBlock), samplesToWrite - written));
        buffer.clear();
        reader->read(&buffer, 0, n, startSample + written, true, true);
        if (!writer->writeFromAudioSampleBuffer(buffer, 0, n))
        {
            error = "Could not write sample audio";
            return false;
        }
        written += n;
    }
    outDurationMs = static_cast<double>(samplesToWrite) * 1000.0 / reader->sampleRate;
    return true;
}

void saveWindowAsSampleAsync(const juce::String& clipId, const juce::String& libraryItemId,
                             const juce::String& newItemId, const juce::String& sampleName,
                             const juce::String& outputDir, const juce::File& sourceFile,
                             double inMs, double durationMs, silverdaw::AudioEngine& engine,
                             silverdaw::ProjectState& projectState, juce::ThreadPool& peakPool,
                             const silverdaw::PeaksCache& cache, silverdaw::BridgeServer& bridge,
                             std::optional<SampleWarpOptions> warpOptions = std::nullopt)
{
    peakPool.addJob(
        [clipId, libraryItemId, newItemId, sampleName, outputDir, sourceFile, inMs, durationMs,
         warpOptions, &engine, &projectState, &cache, &bridge]
        {
            const auto safeName = sanitiseSampleFileName(sampleName);
            const auto outDir = juce::File(outputDir);
            const auto outFile = uniqueWavFile(outDir, safeName);
            double actualDurationMs = 0.0;
            double sampleRate = 0.0;
            int channels = 0;
            juce::String error;
            const bool ok = writeSourceWindowToWav(sourceFile, outFile, inMs, durationMs, engine,
                                                   actualDurationMs, sampleRate, channels, error, warpOptions);
            silverdaw::waveform::PeaksResult peaks;
            juce::File peaksFile;
            if (ok)
            {
                peaks = silverdaw::waveform::computePeaks(outFile, engine.getFormatManager(),
                                                          silverdaw::waveform::kDefaultPeaksPerSecond);
                if (!peaks.peaks.empty())
                {
                    cache.store(outFile, peaks);
                    peaksFile = cache.getCacheFilePath(outFile, silverdaw::waveform::kDefaultPeaksPerSecond);
                }
            }

            juce::MessageManager::callAsync(
                [clipId, libraryItemId, newItemId, safeName, outFile, actualDurationMs, sampleRate, channels,
                 ok, error, peaks, peaksFile, &projectState, &bridge]
                {
                    auto* obj = new juce::DynamicObject();
                    if (clipId.isNotEmpty()) obj->setProperty("clipId", clipId);
                    if (libraryItemId.isNotEmpty()) obj->setProperty("libraryItemId", libraryItemId);
                    obj->setProperty("itemId", newItemId);
                    obj->setProperty("ok", ok && !peaks.peaks.empty());
                    if (!ok || peaks.peaks.empty())
                    {
                        obj->setProperty("error", error.isNotEmpty() ? error : juce::String("Could not create peaks for sample"));
                        bridge.broadcast("SAMPLE_SAVED", juce::var(obj));
                        return;
                    }

                    projectState.getUndoManager().beginNewTransaction("Save sample");
                    projectState.addLibraryItem(newItemId, outFile.getFullPathName(), outFile.getFileName(),
                                                actualDurationMs, static_cast<int>(sampleRate), channels,
                                                outFile.getFullPathName(), {}, "audio-file", safeName);
                    obj->setProperty("filePath", outFile.getFullPathName());
                    obj->setProperty("fileName", outFile.getFileName());
                    obj->setProperty("name", safeName);
                    obj->setProperty("durationMs", actualDurationMs);
                    obj->setProperty("sampleRate", sampleRate);
                    obj->setProperty("channelCount", channels);
                    obj->setProperty("cachePath", peaksFile.getFullPathName());
                    obj->setProperty("peakCount", peaks.bucketsPerLane());
                    obj->setProperty("laneCount", peaks.laneCount);
                    obj->setProperty("peaksPerSecond", silverdaw::effectivePeaksPerSecond(peaks));
                    bridge.broadcast("SAMPLE_SAVED", juce::var(obj));
                    silverdaw::broadcastEditUndoState(projectState, bridge);
                });
        });
}

} // namespace

void handleClipSaveAsSample(const juce::var& payload, silverdaw::AudioEngine& engine,
                            silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                            juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String sampleName = tryGetRequiredString(payload, "sampleName").value_or(juce::String{});
    const juce::String outputDir = tryGetRequiredString(payload, "outputDir").value_or(juce::String{});
    if (clipId.isEmpty() || itemId.isEmpty() || outputDir.isEmpty()) return;
    std::optional<SampleWarpOptions> sampleWarp;
    projectState.forEachWarpClip(
        [&](const silverdaw::ProjectState::WarpClipInfo& info)
        {
            if (info.clipId == clipId)
            {
                SampleWarpOptions opts;
                opts.enabled = info.warpEnabled;
                opts.mode = info.warpMode;
                opts.tempoRatio = info.tempoRatioPinned ? info.tempoRatio : 1.0;
                if (info.warpEnabled && !info.tempoRatioPinned)
                {
                    const auto sourceBpm = projectState.getLibraryItemBpm(info.libraryItemId);
                    const auto projectBpm = projectState.getBpm();
                    if (sourceBpm > 0.0 && projectBpm > 0.0) opts.tempoRatio = projectBpm / sourceBpm;
                }
                opts.semitones = info.semitones;
                opts.cents = info.cents;
                sampleWarp = opts;
            }
        });
    const juce::String libraryItemId = projectState.getClipLibraryItemId(clipId);
    auto sourcePath = projectState.getLibraryItemPlaybackPath(libraryItemId);
    if (sourcePath.isEmpty()) sourcePath = projectState.getClipFilePath(clipId);
    saveWindowAsSampleAsync(clipId, {}, itemId, sampleName, outputDir, juce::File(sourcePath),
                            projectState.getClipInMs(clipId), projectState.getClipDurationMs(clipId),
                            engine, projectState, peakPool, cache, bridge, sampleWarp);
}

void handleLibraryItemSaveAsSample(const juce::var& payload, silverdaw::AudioEngine& engine,
                                   silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                                   juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String sampleName = tryGetRequiredString(payload, "sampleName").value_or(juce::String{});
    const juce::String outputDir = tryGetRequiredString(payload, "outputDir").value_or(juce::String{});
    if (libraryItemId.isEmpty() || itemId.isEmpty() || outputDir.isEmpty()) return;
    juce::var found;
    const auto library = projectState.libraryAsJson();
    if (auto* arr = library.getArray())
    {
        for (const auto& v : *arr)
        {
            if (v.getProperty("id", {}).toString() == libraryItemId)
            {
                found = v;
                break;
            }
        }
    }
    if (!found.isObject()) return;
    const juce::String sourceItemId = found.getProperty("sourceItemId", juce::var()).toString();
    const double sourceInMs = static_cast<double>(found.getProperty("sourceInMs", 0.0));
    const double sourceDurationMs = static_cast<double>(found.getProperty("sourceDurationMs", found.getProperty("durationMs", 0.0)));
    auto sourcePath = projectState.getLibraryItemPlaybackPath(sourceItemId);
    if (sourcePath.isEmpty()) sourcePath = projectState.getLibraryItemFilePath(sourceItemId);
    if (sourcePath.isEmpty()) sourcePath = found.getProperty("filePath", juce::var()).toString();
    std::optional<SampleWarpOptions> sampleWarp;
    if (static_cast<bool>(found.getProperty("warpEnabled", false)))
    {
        SampleWarpOptions opts;
        opts.enabled = true;
        opts.mode = found.getProperty("warpMode", "rhythmic").toString();
        opts.tempoRatio = 1.0;
        if (found.hasProperty("tempoRatio"))
        {
            opts.tempoRatio = static_cast<double>(found.getProperty("tempoRatio", 1.0));
        }
        else
        {
            const auto sourceBpm = projectState.getLibraryItemBpm(sourceItemId);
            const auto projectBpm = projectState.getBpm();
            if (sourceBpm > 0.0 && projectBpm > 0.0) opts.tempoRatio = projectBpm / sourceBpm;
        }
        opts.semitones = static_cast<double>(found.getProperty("semitones", 0.0));
        opts.cents = static_cast<double>(found.getProperty("cents", 0.0));
        sampleWarp = opts;
    }
    saveWindowAsSampleAsync({}, libraryItemId, itemId, sampleName, outputDir, juce::File(sourcePath),
                            sourceInMs, sourceDurationMs, engine, projectState, peakPool, cache, bridge, sampleWarp);
}

} // namespace silverdaw
