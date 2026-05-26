#include "DecodedCache.h"
#include "Log.h"

#include <memory>

namespace silverdaw
{

DecodedCache::DecodedCache()
{
    const auto appData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
    cacheDir = appData.getChildFile("Silverdaw").getChildFile("decoded");
    const auto created = cacheDir.createDirectory();
    if (!created.wasOk())
    {
        silverdaw::log::error("decodedcache",
                              "failed to create cache dir " + cacheDir.getFullPathName() +
                                  ": " + created.getErrorMessage());
    }
}

juce::File DecodedCache::getCacheFilePath(const juce::File& sourceFile) const
{
    return cacheFileFor(sourceFile);
}

juce::File DecodedCache::cacheFileFor(const juce::File& sourceFile) const
{
    // Stable key — identical recipe to `PeaksCache::cacheFileFor`,
    // minus the `peaksPerSecond` component (the WAV is the raw
    // decoded audio, not a derived view of it).
    const auto path = sourceFile.getFullPathName();
    const auto mtime = sourceFile.getLastModificationTime().toMilliseconds();
    const auto size = sourceFile.getSize();
    const auto key = path + "|" + juce::String(mtime) + "|" + juce::String(size);
    const auto hashHex = juce::String::toHexString(static_cast<juce::int64>(key.hashCode64()));
    return cacheDir.getChildFile(hashHex + ".wav");
}

juce::File DecodedCache::ensureDecoded(const juce::File& sourceFile, juce::AudioFormatManager& formatManager) const
{
    const auto cachePath = cacheFileFor(sourceFile);
    if (cachePath.existsAsFile())
    {
        silverdaw::log::debug("decodedcache", "hit " + sourceFile.getFileName());
        return cachePath;
    }
    if (!sourceFile.existsAsFile())
    {
        silverdaw::log::warn("decodedcache", "source missing: " + sourceFile.getFullPathName());
        return {};
    }

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(sourceFile));
    if (reader == nullptr)
    {
        silverdaw::log::warn("decodedcache", "createReaderFor failed: " + sourceFile.getFileName());
        return {};
    }
    if (reader->sampleRate <= 0.0 || reader->numChannels == 0 || reader->lengthInSamples <= 0)
    {
        silverdaw::log::warn("decodedcache", "empty/zero reader for " + sourceFile.getFileName());
        return {};
    }

    // Atomic write: stream to a `.tmp` sibling, then rename when the
    // entire file is written. A partially-written cache entry is
    // never visible to readers.
    const auto tmpPath = cachePath.withFileExtension(".wav.tmp");
    tmpPath.deleteFile();

    auto outStream = std::make_unique<juce::FileOutputStream>(tmpPath);
    if (!outStream->openedOk())
    {
        silverdaw::log::warn("decodedcache",
                             "open tmp failed " + tmpPath.getFullPathName() + ": " + outStream->getStatus().getErrorMessage());
        return {};
    }
    outStream->setPosition(0);
    outStream->truncate();

    juce::WavAudioFormat wavFormat;
    // 16-bit linear PCM: half the size of 32-bit float, indistinguishable
    // from the lossy MP3 source for audio-editing purposes, and what
    // every consumer-grade WAV expects. JUCE writes a standard PCM
    // header; the read path uses the normal `AudioFormatReader`
    // dispatcher with no special handling needed downstream.
    constexpr int kBitsPerSample = 16;
    constexpr int kWriteQuality = 0;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(outStream.get(), reader->sampleRate, reader->numChannels, kBitsPerSample, {},
                                  kWriteQuality));
    if (writer == nullptr)
    {
        silverdaw::log::warn("decodedcache", "createWriterFor failed for " + cachePath.getFileName());
        return {};
    }
    // `createWriterFor` took ownership of `outStream` on success.
    outStream.release();

    // Stream the decoded audio in 4096-sample chunks. The reader
    // decodes lazily; the writer dithers + writes synchronously.
    // Memory footprint: one block at a time.
    constexpr int kBlockSize = 4096;
    if (!writer->writeFromAudioReader(*reader, 0, reader->lengthInSamples))
    {
        silverdaw::log::warn("decodedcache", "writeFromAudioReader failed for " + cachePath.getFileName());
        writer.reset();
        tmpPath.deleteFile();
        return {};
    }
    (void) kBlockSize; // writeFromAudioReader picks its own chunk size internally.
    writer.reset();    // flushes + closes the stream

    if (!tmpPath.moveFileTo(cachePath))
    {
        silverdaw::log::warn("decodedcache",
                             "rename failed " + tmpPath.getFullPathName() + " -> " + cachePath.getFullPathName());
        tmpPath.deleteFile();
        return {};
    }
    silverdaw::log::info("decodedcache",
                         "wrote " + sourceFile.getFileName() + " -> " + cachePath.getFileName() +
                             " (" + juce::String(cachePath.getSize() / 1024) + " KB)");
    return cachePath;
}

juce::File DecodedCache::recreateDecoded(const juce::File& sourceFile, juce::AudioFormatManager& formatManager) const
{
    const auto cachePath = cacheFileFor(sourceFile);
    const auto tmpPath = cachePath.withFileExtension(".wav.tmp");
    if (cachePath.existsAsFile())
    {
        cachePath.deleteFile();
    }
    if (tmpPath.existsAsFile())
    {
        tmpPath.deleteFile();
    }
    return ensureDecoded(sourceFile, formatManager);
}

} // namespace silverdaw
