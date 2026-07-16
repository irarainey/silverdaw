#include "ScratchSourcePreparation.h"

#include "AudioEngine.h"
#include "WarpProcessor.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace silverdaw::scratch
{
namespace
{

constexpr int kPreparationVersion = 1;
constexpr int kRenderBlockSize = 8192;
constexpr double kLongUnwarpedClipSeconds = 30.0;

bool cancelled(const std::function<bool()>& shouldCancel,
               juce::String& error)
{
    if (!shouldCancel || !shouldCancel())
        return false;
    error = "Scratch preparation cancelled";
    return true;
}

juce::File cacheFileFor(const SourcePreparationSettings& settings,
                        const juce::File& cacheDirectory)
{
    juce::String fingerprint;
    fingerprint << "v=" << kPreparationVersion
                << "|path=" << settings.sourceFile.getFullPathName()
                << "|size=" << settings.sourceFile.getSize()
                << "|mtime=" << settings.sourceFile.getLastModificationTime().toMilliseconds()
                << "|in=" << juce::String(settings.inMs, 9)
                << "|duration=" << juce::String(settings.durationMs, 9)
                << "|reverse=" << (settings.reversed ? 1 : 0)
                << "|warp=" << (settings.warpEnabled ? 1 : 0)
                << "|mode=" << settings.warpMode
                << "|ratio=" << juce::String(settings.tempoRatio, 12)
                << "|semitones=" << juce::String(settings.semitones, 9)
                << "|cents=" << juce::String(settings.cents, 9);
    return cacheDirectory.getChildFile(
        "prepared-" + juce::String::toHexString(fingerprint.hashCode64()) + ".wav");
}

bool loadCachedWav(const juce::File& file, PreparedSource& result)
{
    juce::WavAudioFormat wav;
    auto stream = file.createInputStream();
    std::unique_ptr<juce::AudioFormatReader> reader(
        stream != nullptr ? wav.createReaderFor(stream.release(), true) : nullptr);
    if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0
        || reader->lengthInSamples > std::numeric_limits<int>::max())
    {
        return false;
    }

    auto audio = std::make_shared<juce::AudioBuffer<float>>(
        juce::jmax(1, static_cast<int>(reader->numChannels)),
        static_cast<int>(reader->lengthInSamples));
    if (!reader->read(audio.get(), 0, audio->getNumSamples(), 0, true, true))
    {
        return false;
    }
    result.audio = std::move(audio);
    result.sampleRate = reader->sampleRate;
    result.cacheFile = file;
    return true;
}

bool writeCacheWav(const juce::File& file, const juce::AudioBuffer<float>& audio,
                   double sampleRate, juce::String& error)
{
    if (auto parent = file.getParentDirectory();
        !parent.exists() && parent.createDirectory().failed())
    {
        error = "Could not create scratch cache folder";
        return false;
    }
    file.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
    if (stream == nullptr)
    {
        error = "Could not create scratch cache file";
        return false;
    }
    const auto writerOptions = juce::AudioFormatWriterOptions{}
                                   .withSampleRate(sampleRate)
                                   .withNumChannels(audio.getNumChannels())
                                   .withBitsPerSample(32);
    std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, writerOptions));
    if (writer == nullptr)
    {
        error = "Could not create scratch cache writer";
        return false;
    }
    if (!writer->writeFromAudioSampleBuffer(audio, 0, audio.getNumSamples()))
    {
        error = "Could not write prepared scratch audio";
        return false;
    }
    return true;
}

} // namespace

bool prepareSourceToCache(const SourcePreparationSettings& settings,
                          const juce::File& cacheDirectory,
                          AudioEngine& engine,
                          PreparedSource& result,
                          juce::String& error,
                          const std::function<bool()>& shouldCancel,
                          const std::function<void(double)>& reportProgress)
{
    result = {};
    if (reportProgress)
        reportProgress(0.0);
    if (cancelled(shouldCancel, error))
        return false;
    if (!settings.sourceFile.existsAsFile())
    {
        error = "Scratch source file does not exist";
        return false;
    }

    const auto cacheFile = cacheFileFor(settings, cacheDirectory);
    if (cacheFile.existsAsFile() && loadCachedWav(cacheFile, result))
    {
        if (reportProgress)
            reportProgress(1.0);
        return true;
    }

    auto reader = engine.createReaderForClip(settings.sourceFile);
    if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0)
    {
        error = "Could not decode scratch source";
        return false;
    }
    const auto channels = juce::jmax(1, static_cast<int>(reader->numChannels));
    const auto startSample = juce::jlimit(
        static_cast<juce::int64>(0),
        reader->lengthInSamples,
        static_cast<juce::int64>(juce::jmax(0.0, settings.inMs) * reader->sampleRate / 1000.0));
    const auto availableSamples = reader->lengthInSamples - startSample;
    const auto requestedSamples =
        settings.durationMs > 0.0
            ? static_cast<juce::int64>(settings.durationMs * reader->sampleRate / 1000.0)
            : availableSamples;
    const auto sourceSamples = juce::jlimit(
        static_cast<juce::int64>(0), availableSamples, requestedSamples);
    if (sourceSamples <= 0 || sourceSamples > std::numeric_limits<int>::max())
    {
        error = "Scratch clip window is empty or too large";
        return false;
    }

    juce::AudioBuffer<float> source(channels, static_cast<int>(sourceSamples));
    if (!reader->read(&source, 0, source.getNumSamples(), startSample, true, true))
    {
        error = "Could not read scratch clip window";
        return false;
    }
    if (cancelled(shouldCancel, error))
        return false;
    if (reportProgress)
        reportProgress(0.25);
    if (settings.reversed)
    {
        for (int channel = 0; channel < channels; ++channel)
        {
            auto* samples = source.getWritePointer(channel);
            std::reverse(samples, samples + source.getNumSamples());
        }
    }

    const double pitchScale = warpPitchScale(settings.semitones, settings.cents);
    const bool renderWarped =
        settings.warpEnabled
        && (std::abs(settings.tempoRatio - 1.0) > 1.0e-4
            || std::abs(pitchScale - 1.0) > 1.0e-4);
    juce::AudioBuffer<float> prepared;
    if (renderWarped)
    {
        if (!WarpProcessor::supportsChannelCount(channels))
        {
            error = "Scratch preparation cannot warp this channel count";
            return false;
        }
        WarpProcessor warp(
            channels, reader->sampleRate, parseWarpMode(settings.warpMode),
            pitchScale, kRenderBlockSize);
        warp.prepareToPlay(kRenderBlockSize);
        warp.setTempoRatio(settings.tempoRatio);
        warp.seekSource(0);
        const auto outputSamples64 = WarpProcessor::timelineSamplesForSourceSamples(
            sourceSamples, settings.tempoRatio);
        if (outputSamples64 <= 0 || outputSamples64 > std::numeric_limits<int>::max())
        {
            error = "Prepared scratch audio is too large";
            return false;
        }
        prepared.setSize(channels, static_cast<int>(outputSamples64));
        prepared.clear();
        juce::AudioBuffer<float> block(channels, kRenderBlockSize);
        std::vector<float*> outputPointers(static_cast<std::size_t>(channels));
        juce::int64 written = 0;
        while (written < outputSamples64)
        {
            if (cancelled(shouldCancel, error))
                return false;
            const int count = static_cast<int>(juce::jmin(
                static_cast<juce::int64>(kRenderBlockSize), outputSamples64 - written));
            block.clear();
            for (int channel = 0; channel < channels; ++channel)
            {
                outputPointers[static_cast<std::size_t>(channel)] =
                    block.getWritePointer(channel);
            }
            warp.process(
                outputPointers.data(),
                count,
                [&](float* const* destination, juce::int64 sourcePosition, int requested)
                {
                    for (int channel = 0; channel < channels; ++channel)
                    {
                        std::fill(destination[channel], destination[channel] + requested, 0.0F);
                        const auto copyStart = juce::jmax<juce::int64>(0, sourcePosition);
                        const auto copyEnd = juce::jmin<juce::int64>(
                            source.getNumSamples(), sourcePosition + requested);
                        if (copyEnd <= copyStart)
                        {
                            continue;
                        }
                        const int destinationOffset = static_cast<int>(copyStart - sourcePosition);
                        const int copyCount = static_cast<int>(copyEnd - copyStart);
                        juce::FloatVectorOperations::copy(
                            destination[channel] + destinationOffset,
                            source.getReadPointer(channel, static_cast<int>(copyStart)),
                            copyCount);
                    }
                });
            for (int channel = 0; channel < channels; ++channel)
            {
                prepared.copyFrom(channel, static_cast<int>(written), block, channel, 0, count);
            }
            written += count;
            if (reportProgress)
                reportProgress(0.25 + 0.65
                    * static_cast<double>(written)
                    / static_cast<double>(outputSamples64));
        }
    }
    else
    {
        prepared = std::move(source);
        if (sourceSamples / reader->sampleRate >= kLongUnwarpedClipSeconds)
        {
            result.audio =
                std::make_shared<juce::AudioBuffer<float>>(std::move(prepared));
            result.sampleRate = reader->sampleRate;
            return true;
        }
    }

    if (cancelled(shouldCancel, error))
        return false;
    if (reportProgress)
        reportProgress(0.92);
    if (!writeCacheWav(cacheFile, prepared, reader->sampleRate, error)
        || !loadCachedWav(cacheFile, result))
    {
        if (error.isEmpty())
        {
            error = "Could not load prepared scratch cache";
        }
        cacheFile.deleteFile();
        return false;
    }
    if (reportProgress)
        reportProgress(1.0);
    return true;
}

} // namespace silverdaw::scratch
