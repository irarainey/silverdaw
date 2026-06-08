#include "PeaksCache.h"
#include "Log.h"

#include <cstring>

namespace silverdaw
{

namespace
{

// Versioned fixed offsets avoid struct-padding mismatches being read as valid cache data.
constexpr std::uint32_t kCacheMagic = 0x53445057U; // 'SDPW' little-endian
constexpr std::uint32_t kCacheVersion = 2U;

constexpr int kOffMagic = 0;
constexpr int kOffVersion = 4;
constexpr int kOffPeaksPerSecond = 8;
constexpr int kOffPeakCount = 12; // buckets PER LANE
constexpr int kOffLaneCount = 16;
constexpr int kOffSampleRate = 20; // f64
constexpr int kHeaderSize = 28;

// Defensive upper bound on stored lanes (mono summary = 1, stereo = 3).
constexpr std::uint32_t kMaxLaneCount = 8U;

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
    // Key includes path, mtime, size, and density so source changes invalidate cache.
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

    std::uint8_t hdrBytes[kHeaderSize]{};
    if (stream.read(hdrBytes, sizeof(hdrBytes)) != sizeof(hdrBytes))
    {
        return result;
    }
    const auto magic = readU32(hdrBytes + kOffMagic);
    const auto version = readU32(hdrBytes + kOffVersion);
    const auto peaksPerSec = readU32(hdrBytes + kOffPeaksPerSecond);
    const auto peakCount = readU32(hdrBytes + kOffPeakCount);
    const auto laneCount = readU32(hdrBytes + kOffLaneCount);
    double sampleRate = 0.0;
    std::memcpy(&sampleRate, hdrBytes + kOffSampleRate, sizeof(double));

    if (magic != kCacheMagic || version != kCacheVersion ||
        peaksPerSec != static_cast<std::uint32_t>(peaksPerSecond) || laneCount < 1U || laneCount > kMaxLaneCount)
    {
        silverdaw::log::info("peakscache", "stale entry; recomputing " + sourceFile.getFileName());
        return result;
    }

    result.laneCount = static_cast<int>(laneCount);
    const auto floatCount = static_cast<std::size_t>(peakCount) * 2U * static_cast<std::size_t>(laneCount);
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
    // Sibling-temp rename prevents crash-truncated cache files from being honoured.
    const auto tmp = target.getSiblingFile(target.getFileName() + ".tmp");
    tmp.deleteFile();

    std::uint8_t hdr[kHeaderSize]{};
    const auto laneCount = result.laneCount > 0 ? result.laneCount : 1;
    const auto bucketsPerLane = static_cast<std::uint32_t>(result.peaks.size() / (2U * static_cast<std::size_t>(laneCount)));
    writeU32(hdr + kOffMagic, kCacheMagic);
    writeU32(hdr + kOffVersion, kCacheVersion);
    writeU32(hdr + kOffPeaksPerSecond, static_cast<std::uint32_t>(result.peaksPerSecond));
    writeU32(hdr + kOffPeakCount, bucketsPerLane);
    writeU32(hdr + kOffLaneCount, static_cast<std::uint32_t>(laneCount));
    std::memcpy(hdr + kOffSampleRate, &result.sampleRate, sizeof(double));

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
                                            juce::String(static_cast<int>(bucketsPerLane)) +
                                            " lanes=" + juce::String(laneCount));
}

} // namespace silverdaw
