#include "Mp3Export.h"

#include "../core/LamePath.h"

#include <algorithm>
#include <array>
#include <cstring>

namespace silverdaw::mixdown_export
{
namespace
{
int cbrBitrate(int requested)
{
    constexpr std::array rates{32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320};
    return std::find(rates.begin(), rates.end(), requested) != rates.end() ? requested : 192;
}

// LAME's CBR Info frame records the MPEG byte count, excluding any ID3 tags.
// Check it against disk, not JUCE's estimate of MP3 duration (ADR 0029).
bool hasCompleteAudio(const juce::File& file, int bitrate, int sampleRate, int64_t frames)
{
    juce::FileInputStream in(file);
    std::array<juce::uint8, 10> header{};
    if (frames <= 0 || !in.openedOk() || in.read(header.data(), 10) != 10)
        return false;
    juce::int64 audioStart = 0;
    if (std::memcmp(header.data(), "ID3", 3) == 0)
    {
        int tagBytes = 0;
        for (size_t i = 6; i < header.size(); ++i)
        {
            if (header[i] >= 128) return false;
            tagBytes = tagBytes * 128 + header[i];
        }
        audioStart = 10 + tagBytes;
    }

    if (!in.setPosition(audioStart) || in.read(header.data(), 4) != 4 ||
        header[0] != 0xff || (header[1] & 0xe6) != 0xe2) // MPEG Layer III
        return false;
    const auto remainingBytes = in.getTotalLength() - audioStart;
    const auto minimumAudioBytes = frames * bitrate * 1000 / (8LL * sampleRate);
    if (remainingBytes < minimumAudioBytes)
        return false;

    // At low legacy bitrates there may not be room for an Info tag. All three
    // selectable rates use MPEG-1 stereo (4 header bytes + 32 side-info bytes).
    if (bitrate < 128) return true;
    const auto infoStart = audioStart + 36;
    if (!in.setPosition(infoStart) || in.read(header.data(), 4) != 4 ||
        std::memcmp(header.data(), "Info", 4) != 0 || in.readIntBigEndian() != 0x0f)
        return false;
    const auto mpegFrames = static_cast<juce::uint32>(in.readIntBigEndian());
    const juce::int64 encodedBytes = static_cast<juce::uint32>(in.readIntBigEndian());
    // The full 120-byte Info header is followed by the LAME extension; its
    // two 12-bit gapless fields remove encoder delay and final frame padding.
    if (!in.setPosition(infoStart + 120 + 21) || in.read(header.data(), 3) != 3) return false;
    const int delay = (header[0] << 4) | (header[1] >> 4);
    const int padding = ((header[1] & 15) << 8) | header[2];
    if (static_cast<int64_t>(mpegFrames) * 1152 - delay - padding != frames || encodedBytes < minimumAudioBytes)
        return false;
    return remainingBytes == encodedBytes ||
           (remainingBytes == encodedBytes + 128 && in.setPosition(audioStart + encodedBytes) &&
            in.read(header.data(), 3) == 3 && std::memcmp(header.data(), "TAG", 3) == 0);
}
} // namespace

juce::Result encodeMp3(const juce::File& lame, const juce::File& pcm, const juce::File& output,
                       const MixdownOptions& options, int64_t frames, const std::atomic<bool>& cancel)
{
    if (cancel.load()) return juce::Result::fail("Cancelled.");
    const auto bitrate = cbrBitrate(options.bitrateKbps);
    juce::StringArray args{lame.getFullPathName(), "--quiet", "--cbr", "-b", juce::String(bitrate)};
    const auto tag = [&](const char* flag, const juce::String& value) {
        if (value.isNotEmpty()) { args.add(flag); args.add(value); }
    };
    const auto& md = options.metadata;
    tag("--tt", md.title);
    tag("--ta", md.artist);
    tag("--tl", md.album);
    tag("--ty", md.year);
    tag("--tg", md.genre);
    tag("--tc", md.comment);
    args.add(pcm.getFullPathName());
    args.add(output.getFullPathName());

    juce::ChildProcess child;
    if (!child.start(args, 0))
        return juce::Result::fail("Could not start the bundled MP3 encoder.");
    const auto start = juce::Time::getMillisecondCounter();
    const auto timeout = static_cast<juce::uint32>(lameTimeoutMsFor(pcm));
    while (!child.waitForProcessToFinish(50))
    {
        if (cancel.load() || juce::Time::getMillisecondCounter() - start >= timeout)
        {
            child.kill();
            child.waitForProcessToFinish(-1);
            return juce::Result::fail(cancel.load() ? "Cancelled." : "MP3 encoder timed out.");
        }
    }
    const auto exit = child.getExitCode();
    if (exit != 0)
        return juce::Result::fail("MP3 encoder failed (exit " + juce::String(exit) + ").");
    if (!hasCompleteAudio(output, bitrate, options.outputSampleRate, frames))
        return juce::Result::fail("MP3 encoder produced an invalid or incomplete file.");
    return juce::Result::ok();
}
} // namespace silverdaw::mixdown_export
