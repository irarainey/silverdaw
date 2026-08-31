#include "DecodedCache.h"

#include "../core/LamePath.h"
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
    if (!slot)
        slot = std::make_unique<std::mutex>();
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
//  3: MP3 decoded by the bundled LAME. JUCE's MP3 reader mis-parses some files
//     outright — one 192 kbps file was sized as if it were 256 kbps, so every frame
//     boundary after the first was wrong, every read failed and the file could be
//     neither played nor analysed. Across a 25-file sample JUCE also stopped early on
//     18 of them (accepted as a "short tail"), where LAME decoded all 25 in full at the
//     same speed. LAME additionally strips the ~529-sample MP3 encoder delay that JUCE
//     leaves in, so decodes from this generation start ~12 ms earlier than before and
//     beat grids derived from them are re-derived against the corrected audio.
constexpr int kDecodedCacheGeneration = 3;

// The identity half of the key, shared by the current and superseded generations.
juce::String decodedCacheKeyFor(const juce::File& sourceFile)
{
    return sourceFile.getFullPathName() + "|" + juce::String(sourceFile.getLastModificationTime().toMilliseconds()) +
           "|" + juce::String(sourceFile.getSize());
}

juce::File cacheFileForKey(const juce::File& cacheDir, const juce::String& key)
{
    const auto hashHex = juce::String::toHexString(static_cast<juce::int64>(key.hashCode64()));
    return cacheDir.getChildFile(hashHex + ".wav");
}

// Decoding a whole file must never wedge a worker if the child process hangs (a
// malformed file, or antivirus holding the executable). Scale the ceiling with the
// source size so a long DJ set is not cut off, but keep it bounded. Decoding runs at
// roughly 0.3 s per 5-minute track, so this is orders of magnitude of headroom.
int lameTimeoutMsFor(const juce::File& sourceFile)
{
    constexpr int kFloorMs = 60'000;
    constexpr int kCeilingMs = 600'000;
    const auto megabytes = static_cast<double>(sourceFile.getSize()) / (1024.0 * 1024.0);
    const auto scaled = static_cast<int>(megabytes * 10'000.0);
    return juce::jlimit(kFloorMs, kCeilingMs, scaled);
}

// Decode an MP3 to 16-bit PCM WAV with the bundled LAME, straight into `destWav`.
//
// Preferred over JUCE's MP3 reader for every MP3: JUCE mis-parses some files so badly
// that they cannot be played at all, and stops short on most others. LAME is already
// shipped for MP3 export, so this adds no new dependency.
bool decodeMp3WithLame(const juce::File& sourceFile, const juce::File& destWav)
{
    const auto lameExe = findLameExecutable();
    if (!lameExe.existsAsFile())
    {
        silverdaw::log::warn("decodedcache", "lame.exe not found at " + lameExe.getFullPathName() +
                                                 " — falling back to the built-in MP3 reader");
        return false;
    }

    // Pass arguments as a list, never a hand-built command line, so spaces, Unicode
    // and shell metacharacters in music filenames are quoted correctly.
    juce::StringArray args;
    args.add(lameExe.getFullPathName());
    args.add("--decode");
    args.add("--quiet");
    args.add(sourceFile.getFullPathName());
    args.add(destWav.getFullPathName());

    juce::ChildProcess process;
    if (!process.start(args, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
    {
        silverdaw::log::warn("decodedcache", "failed to launch lame for " + sourceFile.getFileName());
        return false;
    }

    const auto timeoutMs = lameTimeoutMsFor(sourceFile);
    if (!process.waitForProcessToFinish(timeoutMs))
    {
        process.kill();
        silverdaw::log::warn("decodedcache", "lame timed out after " + juce::String(timeoutMs / 1000) + "s decoding " +
                                                 sourceFile.getFileName());
        return false;
    }

    const auto exitCode = process.getExitCode();
    if (exitCode != 0)
    {
        // `--quiet` keeps this short; it is the only diagnostic LAME gives us.
        const auto output = process.readAllProcessOutput().trim();
        silverdaw::log::warn("decodedcache", "lame failed (exit " + juce::String(exitCode) + ") on " +
                                                 sourceFile.getFileName() +
                                                 (output.isEmpty() ? juce::String() : ": " + output));
        return false;
    }
    return true;
}
} // namespace

// A decoded WAV is only usable if it reads back as real audio; a zero exit code
// alone does not prove LAME wrote something we can play.
bool decodedWavIsUsable(const juce::File& wav)
{
    if (!wav.existsAsFile())
        return false;
    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::AudioFormatReader> reader(wavFormat.createReaderFor(new juce::FileInputStream(wav), true));
    return reader != nullptr && reader->sampleRate > 0.0 && reader->numChannels > 0 && reader->lengthInSamples > 0;
}

namespace
{

// Decode any source JUCE can read into 16-bit PCM WAV at `tmpPath`.
//
// Retained as the path for non-MP3 compressed formats, and as a safety net if the
// bundled LAME is missing or fails on an MP3, so this can only ever add coverage.
bool decodeWithJuceReader(const juce::File& sourceFile, const juce::File& tmpPath,
                          juce::AudioFormatManager& formatManager)
{
    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(sourceFile));
    if (reader == nullptr)
    {
        silverdaw::log::warn("decodedcache", "createReaderFor failed: " + sourceFile.getFileName());
        return false;
    }
    if (reader->sampleRate <= 0.0 || reader->numChannels == 0 || reader->lengthInSamples <= 0)
    {
        silverdaw::log::warn("decodedcache", "empty/zero reader for " + sourceFile.getFileName());
        return false;
    }

    tmpPath.deleteFile();
    auto outStream = std::make_unique<juce::FileOutputStream>(tmpPath);
    if (!outStream->openedOk())
    {
        silverdaw::log::warn("decodedcache", "open tmp failed " + tmpPath.getFullPathName() + ": " +
                                                 outStream->getStatus().getErrorMessage());
        return false;
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
        silverdaw::log::warn("decodedcache", "createWriterFor failed for " + tmpPath.getFileName());
        return false;
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
        silverdaw::log::warn("decodedcache", "decode failed for " + sourceFile.getFileName() + ": wrote " +
                                                 juce::String(decoded.samplesWritten) + " of " +
                                                 juce::String(expectedSamples) + " samples" +
                                                 (decoded.writeFailed ? " (write error)" : " (read error)"));
        tmpPath.deleteFile();
        return false;
    }
    if (decoded.samplesWritten < expectedSamples)
    {
        silverdaw::log::info("decodedcache", "short tail on " + sourceFile.getFileName() + ": kept " +
                                                 juce::String(decoded.samplesWritten) + " of " +
                                                 juce::String(expectedSamples) + " estimated samples");
    }
    return true;
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
                juce::FloatVectorOperations::convertFixedToFloat(block.getWritePointer(ch),
                                                                 channels[static_cast<size_t>(ch)], scale, numToDo);
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
        silverdaw::log::error("decodedcache", "failed to create cache dir " + cacheDir.getFullPathName() + ": " +
                                                  created.getErrorMessage());
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
        if (probe != nullptr && probe->sampleRate > 0.0 && probe->numChannels > 0 && probe->lengthInSamples > 0)
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

    // Write caches to a sibling temp file so partial entries are never visible.
    const auto tmpPath = cachePath.withFileExtension(".wav.tmp");
    tmpPath.deleteFile();

    // The cache key is built from the source's size and modification time. A file
    // replaced in place while a decode is running would otherwise commit the new
    // audio under the old key, and every later lookup would hit it.
    const auto sizeBefore = sourceFile.getSize();
    const auto modifiedBefore = sourceFile.getLastModificationTime();

    // MP3 goes through LAME first: JUCE's own MP3 reader mis-parses some files
    // completely (leaving them unplayable and unanalysable) and stops short on many
    // more. JUCE remains the fallback so a missing or failing LAME can only ever
    // return us to the previous behaviour, never worse.
    bool decodedOk = false;
    juce::String decoder = "juce";
    if (sourceFile.hasFileExtension("mp3"))
    {
        if (decodeMp3WithLame(sourceFile, tmpPath) && decodedWavIsUsable(tmpPath))
        {
            decodedOk = true;
            decoder = "lame";
        }
        else
        {
            tmpPath.deleteFile();
            silverdaw::log::info("decodedcache",
                                 "lame could not decode " + sourceFile.getFileName() + " — trying the built-in reader");
        }
    }
    if (!decodedOk)
    {
        decodedOk = decodeWithJuceReader(sourceFile, tmpPath, formatManager);
    }
    if (!decodedOk)
    {
        tmpPath.deleteFile();
        return {};
    }

    if (sourceFile.getSize() != sizeBefore || sourceFile.getLastModificationTime() != modifiedBefore)
    {
        silverdaw::log::warn("decodedcache",
                             "source changed while decoding " + sourceFile.getFileName() + " — discarding this decode");
        tmpPath.deleteFile();
        return {};
    }

    if (!tmpPath.moveFileTo(cachePath))
    {
        silverdaw::log::warn("decodedcache",
                             "rename failed " + tmpPath.getFullPathName() + " -> " + cachePath.getFullPathName());
        tmpPath.deleteFile();
        return {};
    }
    silverdaw::log::info("decodedcache", "wrote " + sourceFile.getFileName() + " -> " + cachePath.getFileName() + " (" +
                                             juce::String(cachePath.getSize() / 1024) + " KB, via " + decoder + ")");
    // Only once the replacement is committed, so a failed decode never leaves the
    // source with no cached entry at all.
    for (const auto& superseded : supersededCacheFilesFor(sourceFile))
    {
        if (superseded.existsAsFile() && superseded.deleteFile())
        {
            silverdaw::log::info("decodedcache", "removed superseded entry " + superseded.getFileName() + " for " +
                                                     sourceFile.getFileName());
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
