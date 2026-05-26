#include "PeaksCache.h"
#include "Log.h"

#include <cstring>

namespace silverdaw
{

namespace
{

// On-disk preamble. Kept minimal but versioned so future format changes
// (e.g. switching to int16-quantised peaks) can be detected as a miss
// rather than misinterpreted.
constexpr std::uint32_t kCacheMagic = 0x53445057U; // 'SDPW' little-endian
constexpr std::uint32_t kCacheVersion = 1U;

struct CacheHeader
{
    std::uint32_t magic;
    std::uint32_t version;
    std::uint32_t peaksPerSecond;
    std::uint32_t peakCount;
    double sampleRate;
};
static_assert(sizeof(CacheHeader) == 24, "CacheHeader layout assumption changed");

void writeU32(std::uint8_t* dest, std::uint32_t value)
{
    dest[0] = static_cast<std::uint8_t>(value & 0xFFU);
    dest[1] = static_cast<std::uint8_t>((value >> 8) & 0xFFU);
    dest[2] = static_cast<std::uint8_t>((value >> 16) & 0xFFU);
    dest[3] = static_cast<std::uint8_t>((value >> 24) & 0xFFU);
}

std::uint32_t readU32(const std::uint8_t* src)
{
    return static_cast<std::uint32_t>(src[0]) | (static_cast<std::uint32_t>(src[1]) << 8) |
           (static_cast<std::uint32_t>(src[2]) << 16) | (static_cast<std::uint32_t>(src[3]) << 24);
}

} // namespace

PeaksCache::PeaksCache()
{
    const auto appData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
    cacheDir = appData.getChildFile("Silverdaw").getChildFile("peaks");
    const auto created = cacheDir.createDirectory();
    if (!created.wasOk())
    {
        silverdaw::log::error("peakscache",
                              "failed to create cache dir " + cacheDir.getFullPathName() +
                                  ": " + created.getErrorMessage());
    }
}

PeaksCache::PeaksCache(const juce::File& cacheDirectory) : cacheDir(cacheDirectory)
{
    const auto created = cacheDir.createDirectory();
    if (!created.wasOk())
    {
        silverdaw::log::error("peakscache",
                              "failed to create cache dir " + cacheDir.getFullPathName() +
                                  ": " + created.getErrorMessage());
    }
}

juce::File PeaksCache::getCacheFilePath(const juce::File& sourceFile, int peaksPerSecond) const
{
    return cacheFileFor(sourceFile, peaksPerSecond);
}

juce::File PeaksCache::cacheFileFor(const juce::File& sourceFile, int peaksPerSecond) const
{
    // Stable key: full path + mtime + size + peaks/s. Any of those
    // changing must invalidate the entry. We hash via MD5 (cheap, in
    // juce_core, collision-safe for our address space).
    const auto path = sourceFile.getFullPathName();
    const auto mtime = sourceFile.getLastModificationTime().toMilliseconds();
    const auto size = sourceFile.getSize();
    const auto key = path + "|" + juce::String(mtime) + "|" + juce::String(size) + "|" + juce::String(peaksPerSecond);
    const auto hashHex = juce::String::toHexString(static_cast<juce::int64>(key.hashCode64()));
    return cacheDir.getChildFile(hashHex + ".peaks");
}

waveform::PeaksResult PeaksCache::tryLoad(const juce::File& sourceFile, int peaksPerSecond) const
{
    waveform::PeaksResult result;
    result.peaksPerSecond = peaksPerSecond;

    const auto file = cacheFileFor(sourceFile, peaksPerSecond);
    if (!file.existsAsFile())
    {
        silverdaw::log::debug("peakscache", "miss " + sourceFile.getFileName());
        return result;
    }

    juce::FileInputStream stream(file);
    if (!stream.openedOk())
    {
        silverdaw::log::warn("peakscache", "open failed " + file.getFileName());
        return result;
    }

    std::uint8_t hdrBytes[sizeof(CacheHeader)]{};
    if (stream.read(hdrBytes, sizeof(hdrBytes)) != sizeof(hdrBytes))
    {
        return result;
    }
    const auto magic = readU32(hdrBytes);
    const auto version = readU32(hdrBytes + 4);
    const auto peaksPerSec = readU32(hdrBytes + 8);
    const auto peakCount = readU32(hdrBytes + 12);
    double sampleRate = 0.0;
    std::memcpy(&sampleRate, hdrBytes + 16, sizeof(double));

    if (magic != kCacheMagic || version != kCacheVersion ||
        peaksPerSec != static_cast<std::uint32_t>(peaksPerSecond))
    {
        silverdaw::log::info("peakscache", "stale entry; recomputing " + sourceFile.getFileName());
        return result;
    }

    const auto floatCount = static_cast<std::size_t>(peakCount) * 2U;
    result.peaks.resize(floatCount);
    const auto bytesNeeded = floatCount * sizeof(float);
    if (bytesNeeded > 0)
    {
        const auto bytesRead = stream.read(result.peaks.data(), static_cast<int>(bytesNeeded));
        if (static_cast<std::size_t>(bytesRead) != bytesNeeded)
        {
            result.peaks.clear();
            silverdaw::log::warn("peakscache", "short read " + file.getFileName());
            return result;
        }
    }
    result.sampleRate = sampleRate;
    silverdaw::log::info("peakscache", "hit " + sourceFile.getFileName() + " peaks=" + juce::String(static_cast<int>(peakCount)));
    return result;
}

void PeaksCache::store(const juce::File& sourceFile, const waveform::PeaksResult& result) const
{
    if (result.peaks.empty())
    {
        return;
    }

    const auto target = cacheFileFor(sourceFile, result.peaksPerSecond);
    // Write to a temp sibling and rename so a crash mid-write can never
    // leave a half-written cache file (which would be honoured by a
    // future tryLoad with garbage data).
    const auto tmp = target.getSiblingFile(target.getFileName() + ".tmp");
    tmp.deleteFile();

    std::uint8_t hdr[sizeof(CacheHeader)]{};
    writeU32(hdr, kCacheMagic);
    writeU32(hdr + 4, kCacheVersion);
    writeU32(hdr + 8, static_cast<std::uint32_t>(result.peaksPerSecond));
    writeU32(hdr + 12, static_cast<std::uint32_t>(result.peaks.size() / 2U));
    std::memcpy(hdr + 16, &result.sampleRate, sizeof(double));

    {
        juce::FileOutputStream out(tmp);
        if (!out.openedOk())
        {
            silverdaw::log::error("peakscache", "failed to open temp " + tmp.getFullPathName());
            return;
        }
        out.write(hdr, sizeof(hdr));
        out.write(result.peaks.data(), result.peaks.size() * sizeof(float));
        out.flush();
        if (out.getStatus().failed())
        {
            silverdaw::log::error("peakscache", "write failed: " + out.getStatus().getErrorMessage());
            return;
        }
    } // close before rename

    target.deleteFile();
    if (!tmp.moveFileTo(target))
    {
        silverdaw::log::warn("peakscache", "rename failed " + target.getFileName());
        tmp.deleteFile();
        return;
    }
    silverdaw::log::info("peakscache", "store " + sourceFile.getFileName() + " peaks=" +
                                            juce::String(static_cast<int>(result.peaks.size() / 2U)));
}

} // namespace silverdaw
