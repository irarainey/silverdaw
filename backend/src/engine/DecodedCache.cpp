#include "DecodedCache.h"
#include "Log.h"

#include <algorithm>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

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
    std::scoped_lock guard(mapMutex);
    auto& slot = locks[key];
    if (!slot) slot = std::make_unique<std::mutex>();
    return *slot;
}

// Bump when a decoding change could invalidate every entry written before it — a new or
// replaced reader, or a change to the cached format.
//
// The key is the source's path, mtime and size, none of which change when a file is
// re-imported, so without this a bad decode is served for the life of that file: even
// deleting and re-adding the item hits the same entry. The generation gives us a way to
// abandon a whole vintage of entries, and the superseded file is deleted once its source
// is decoded again, so nothing is orphaned that we could have cleaned up.
//
//  1: original key; MP3 was read by Windows Media Foundation, which mis-reported the
//     length of at least one file and cached a decode truncated to a fraction of a second.
//  2: MP3 read by JUCE's own decoder.
constexpr int kDecodedCacheGeneration = 2;

// The identity half of the key, shared by the current and superseded generations.
juce::String decodedCacheKeyFor(const juce::File& sourceFile)
{
    return sourceFile.getFullPathName() + "|"
           + juce::String(sourceFile.getLastModificationTime().toMilliseconds()) + "|"
           + juce::String(sourceFile.getSize());
}

juce::File cacheFileForKey(const juce::File& cacheDir, const juce::String& key)
{
    const auto hashHex = juce::String::toHexString(static_cast<juce::int64>(key.hashCode64()));
    return cacheDir.getChildFile(hashHex + ".wav");
}
} // namespace

DecodeResult writeDecodedBlocks(juce::AudioFormatReader& reader, juce::AudioFormatWriter& writer)
{
    constexpr int kBlockSize = 16384;
    const int numChannels = static_cast<int>(reader.numChannels);
    juce::AudioBuffer<float> block(numChannels, kBlockSize);
    std::vector<int*> channels(static_cast<size_t>(numChannels), nullptr);

    DecodeResult result;
    while (result.samplesWritten < reader.lengthInSamples)
    {
        const auto remaining = reader.lengthInSamples - result.samplesWritten;
        const int numToDo = static_cast<int>(std::min<juce::int64>(kBlockSize, remaining));
        // JUCE's readers deliver float data through int pointers into the same storage.
        for (int ch = 0; ch < numChannels; ++ch)
            channels[static_cast<size_t>(ch)] = reinterpret_cast<int*>(block.getWritePointer(ch));

        if (!reader.read(channels.data(), numChannels, result.samplesWritten, numToDo, false))
            break;

        if (!reader.usesFloatingPointData)
        {
            constexpr auto scale = 1.0f / static_cast<float>(0x7fffffff);
            for (int ch = 0; ch < numChannels; ++ch)
                juce::FloatVectorOperations::convertFixedToFloat(
                    block.getWritePointer(ch), channels[static_cast<size_t>(ch)], scale, numToDo);
        }

        if (!writer.writeFromAudioSampleBuffer(block, 0, numToDo))
        {
            result.writeFailed = true;
            break;
        }
        result.samplesWritten += numToDo;
    }
    return result;
}

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
    const auto key = decodedCacheKeyFor(sourceFile) + "|g" + juce::String(kDecodedCacheGeneration);
    return cacheFileForKey(cacheDir, key);
}

// Every older generation's entry for this source. Generation 1 predates the marker and
// so carries the bare key.
juce::Array<juce::File> DecodedCache::supersededCacheFilesFor(const juce::File& sourceFile) const
{
    const auto base = decodedCacheKeyFor(sourceFile);
    juce::Array<juce::File> files;
    files.add(cacheFileForKey(cacheDir, base));
    for (int generation = 2; generation < kDecodedCacheGeneration; ++generation)
    {
        files.add(cacheFileForKey(cacheDir, base + "|g" + juce::String(generation)));
    }
    return files;
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
    std::scoped_lock decodeLock(decodeLockFor(cachePath.getFullPathName()));
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

    // `writeFromAudioReader` is all-or-nothing on a length the reader may only have
    // estimated. JUCE sizes an MP3 with no Xing header by dividing the stream by the
    // UNPADDED frame size, which over-runs the real audio by a frame per few hundred
    // padded frames, so the final read fails and an otherwise perfect decode is binned —
    // leaving the file with no decoded WAV, no tempo, and stems that inherit no tempo
    // either. Decode block by block so a short tail costs only the tail.
    const auto decoded = writeDecodedBlocks(*reader, *writer);
    writer.reset(); // flushes + closes the stream

    const auto expectedSamples = reader->lengthInSamples;
    const bool tooShort =
        decoded.samplesWritten < static_cast<juce::int64>(static_cast<double>(expectedSamples) * kMinDecodedFraction);
    if (decoded.writeFailed || decoded.samplesWritten <= 0 || tooShort)
    {
        silverdaw::log::warn("decodedcache",
                             "decode failed for " + cachePath.getFileName() + ": wrote "
                                 + juce::String(decoded.samplesWritten) + " of "
                                 + juce::String(expectedSamples) + " samples");
        tmpPath.deleteFile();
        return {};
    }
    if (decoded.samplesWritten < expectedSamples)
    {
        silverdaw::log::info("decodedcache",
                             "short tail on " + sourceFile.getFileName() + ": kept "
                                 + juce::String(decoded.samplesWritten) + " of "
                                 + juce::String(expectedSamples) + " estimated samples");
    }

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
    // Only once the replacement is committed, so a failed decode never leaves the
    // source with no cached entry at all.
    for (const auto& superseded : supersededCacheFilesFor(sourceFile))
    {
        if (superseded.existsAsFile() && superseded.deleteFile())
        {
            silverdaw::log::info("decodedcache",
                                 "removed superseded entry " + superseded.getFileName() + " for "
                                     + sourceFile.getFileName());
        }
    }
    return cachePath;
}

juce::File DecodedCache::recreateDecoded(const juce::File& sourceFile, juce::AudioFormatManager& formatManager) const
{
    const auto cachePath = cacheFileFor(sourceFile);
    const auto tmpPath = cachePath.withFileExtension(".wav.tmp");
    {
        // Delete under the same per-path lock ensureDecoded uses, so a concurrent
        // decode can't observe the cache mid-removal.
        std::scoped_lock decodeLock(decodeLockFor(cachePath.getFullPathName()));
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
