#include "DecodedCache.h"
#include "Log.h"

#include <map>
#include <memory>
#include <mutex>
#include <string>

namespace silverdaw
{

namespace
{
// Per-cache-file lock: several worker jobs (BPM detection from LIBRARY_ADD and
// from CLIP_ADD, plus the clip-add decode) can call ensureDecoded for the SAME
// source at once. They all target one fixed `<hash>.wav.tmp`, so without
// serialisation the losers hit "file in use" on the tmp open, return no WAV, and
// (for BPM) report no tempo. Serialising per cache path makes the first caller
// decode while the rest wait, then reuse the finished cache.
std::mutex& decodeLockFor(const juce::String& cachePath)
{
    static std::mutex mapMutex;
    static std::map<std::string, std::unique_ptr<std::mutex>> locks;
    const auto key = cachePath.toStdString();
    std::lock_guard<std::mutex> guard(mapMutex);
    auto& slot = locks[key];
    if (!slot) slot = std::make_unique<std::mutex>();
    return *slot;
}
} // namespace

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
    const auto path = sourceFile.getFullPathName();
    const auto mtime = sourceFile.getLastModificationTime().toMilliseconds();
    const auto size = sourceFile.getSize();
    const auto key = path + "|" + juce::String(mtime) + "|" + juce::String(size);
    const auto hashHex = juce::String::toHexString(static_cast<juce::int64>(key.hashCode64()));
    return cacheDir.getChildFile(hashHex + ".wav");
}

juce::File DecodedCache::ensureDecoded(const juce::File& sourceFile, juce::AudioFormatManager& formatManager) const
{
    // A source that is already a readable WAV needs no decoded duplicate: JUCE reads
    // any PCM/float WAV directly into float buffers, so playback, warping and peak
    // generation all work straight from the original file. Returning it as-is avoids
    // a wasteful (and, for 32-bit-float stems, lossy 16-bit) copy in the central
    // cache — stems already live beside the project as WAVs. Prefer the original over
    // any (possibly stale) cache entry so the highest-quality source is played.
    if (sourceFile.existsAsFile() && sourceFile.hasFileExtension("wav"))
    {
        std::unique_ptr<juce::AudioFormatReader> probe(formatManager.createReaderFor(sourceFile));
        if (probe != nullptr && probe->sampleRate > 0.0 && probe->numChannels > 0
            && probe->lengthInSamples > 0)
        {
            silverdaw::log::debug("decodedcache", "skip (already wav) " + sourceFile.getFileName());
            return sourceFile;
        }
    }

    const auto cachePath = cacheFileFor(sourceFile);
    // Serialise writers for this cache file (see decodeLockFor). A concurrent
    // caller blocks here, then falls through to the cache-hit check below and
    // reuses the WAV the first caller just wrote.
    std::lock_guard<std::mutex> decodeLock(decodeLockFor(cachePath.getFullPathName()));
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

    // Write caches to a sibling temp file so partial entries are never visible.
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
    // Cache WAVs as 16-bit PCM to keep decoded files small and universally readable.
    constexpr int kBitsPerSample = 16;
    const auto writerOptions = juce::AudioFormatWriterOptions{}
                                   .withSampleRate(reader->sampleRate)
                                   .withNumChannels(static_cast<int>(reader->numChannels))
                                   .withBitsPerSample(kBitsPerSample);
    std::unique_ptr<juce::OutputStream> baseStream(std::move(outStream));
    std::unique_ptr<juce::AudioFormatWriter> writer(wavFormat.createWriterFor(baseStream, writerOptions));
    if (writer == nullptr)
    {
        silverdaw::log::warn("decodedcache", "createWriterFor failed for " + cachePath.getFileName());
        return {};
    }
    // The writer took ownership of the stream on success.

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
    {
        // Delete under the same per-path lock ensureDecoded uses, so a concurrent
        // decode can't observe the cache mid-removal.
        std::lock_guard<std::mutex> decodeLock(decodeLockFor(cachePath.getFullPathName()));
        if (cachePath.existsAsFile())
        {
            cachePath.deleteFile();
        }
        if (tmpPath.existsAsFile())
        {
            tmpPath.deleteFile();
        }
    }
    return ensureDecoded(sourceFile, formatManager);
}

} // namespace silverdaw
