// Decoding a source into the WAV cache must tolerate a reader that over-reports its
// length. JUCE sizes a CBR MP3 with no Xing header by dividing the stream by the
// UNPADDED frame size, so it claims a handful of frames more than the file holds; the
// old all-or-nothing copy then threw away an otherwise complete decode, leaving the
// item with no tempo and every separated stem inheriting none either.

#include "TestRegistry.h"

#include "DecodedCache.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <memory>

namespace silverdaw::tests
{
namespace
{

constexpr double kTestSampleRate = 44100.0;

// A reader that claims `reportedLength` samples but only has `readableLength` of them,
// mirroring JUCE's MP3 length over-estimate.
class ShortTailReader : public juce::AudioFormatReader
{
  public:
    ShortTailReader(juce::int64 reportedLength, juce::int64 readableLengthIn)
        : juce::AudioFormatReader(nullptr, "ShortTail"), readableLength(readableLengthIn)
    {
        sampleRate = kTestSampleRate;
        bitsPerSample = 16;
        numChannels = 2;
        usesFloatingPointData = true;
        lengthInSamples = reportedLength;
    }

    bool readSamples(int* const* destChannels,
                     int numDestChannels,
                     int startOffsetInDestBuffer,
                     juce::int64 startSampleInFile,
                     int numSamples) override
    {
        const bool runsPastEnd = startSampleInFile + numSamples > readableLength;
        for (int ch = 0; ch < numDestChannels; ++ch)
        {
            if (destChannels[ch] == nullptr) continue;
            auto* dest = reinterpret_cast<float*>(destChannels[ch]) + startOffsetInDestBuffer;
            for (int i = 0; i < numSamples; ++i) dest[i] = 0.25f;
        }
        return !runsPastEnd; // JUCE's MP3 reader zero-fills and reports failure the same way.
    }

    juce::int64 readableLength;
};

// Write `reader` into a throwaway WAV via the production copy loop.
DecodeResult decodeToTempWav(juce::AudioFormatReader& reader, juce::File& outFile)
{
    outFile = juce::File::createTempFile(".wav");
    auto stream = std::make_unique<juce::FileOutputStream>(outFile);
    require(stream->openedOk(), "could not open temp wav for writing");

    juce::WavAudioFormat wavFormat;
    const auto options = juce::AudioFormatWriterOptions{}
                             .withSampleRate(reader.sampleRate)
                             .withNumChannels(static_cast<int>(reader.numChannels))
                             .withBitsPerSample(16);
    std::unique_ptr<juce::OutputStream> baseStream(std::move(stream));
    std::unique_ptr<juce::AudioFormatWriter> writer(wavFormat.createWriterFor(baseStream, options));
    require(writer != nullptr, "could not create wav writer");

    const auto result = writeDecodedBlocks(reader, *writer);
    writer.reset();
    return result;
}

void testShortTailKeepsTheDecodedAudio()
{
    // 5 frames short of the claimed length, as the real 160 kbps MP3 was.
    constexpr juce::int64 kReported = 8008704;
    constexpr juce::int64 kReadable = 8002944;
    ShortTailReader reader(kReported, kReadable);

    juce::File wav;
    const auto result = decodeToTempWav(reader, wav);

    require(!result.writeFailed, "a short tail must not be reported as a write failure");
    require(result.samplesWritten > 0, "a short tail must not discard the whole decode");
    require(result.samplesWritten
                >= static_cast<juce::int64>(static_cast<double>(kReported) * kMinDecodedFraction),
            "a short tail must stay above the minimum decoded fraction");
    require(result.samplesWritten <= kReadable, "must not claim more samples than the reader held");
    wav.deleteFile();
}

void testAFullReadWritesEverySample()
{
    constexpr juce::int64 kLength = 200000;
    ShortTailReader reader(kLength, kLength);

    juce::File wav;
    const auto result = decodeToTempWav(reader, wav);

    require(!result.writeFailed, "a complete read must not report a write failure");
    require(result.samplesWritten == kLength, "a complete read must write every sample");
    wav.deleteFile();
}

void testATruncatedDecodeFallsBelowTheThreshold()
{
    // Only a fraction readable: this is a genuinely broken file, not a tail estimate.
    constexpr juce::int64 kReported = 8008704;
    constexpr juce::int64 kReadable = 44100;
    ShortTailReader reader(kReported, kReadable);

    juce::File wav;
    const auto result = decodeToTempWav(reader, wav);

    require(result.samplesWritten
                < static_cast<juce::int64>(static_cast<double>(kReported) * kMinDecodedFraction),
            "a badly truncated decode must fall below the minimum decoded fraction");
    wav.deleteFile();
}

// The staging path a real decode writes to is `<hash>.wav.tmp`. Validating it through
// AudioFormatManager, which picks a reader by file extension, silently rejected every
// good decode because nothing is registered for `.tmp` — which disabled the MP3
// decoder entirely while looking like a decode failure.
void testAUsableWavIsAcceptedOnATmpStagingPath()
{
    constexpr juce::int64 kLength = 50000;
    ShortTailReader reader(kLength, kLength);

    juce::File wav;
    const auto result = decodeToTempWav(reader, wav);
    require(result.samplesWritten == kLength, "the fixture decode must succeed");

    const auto staged = wav.getSiblingFile(wav.getFileName() + ".tmp");
    staged.deleteFile();
    require(wav.moveFileTo(staged), "must be able to stage the wav under a .wav.tmp name");

    require(decodedWavIsUsable(staged),
            "a real wav must validate even when staged under a .wav.tmp extension");
    staged.deleteFile();
}

void testAnUnusableDecodeIsRejected()
{
    const auto missing = juce::File::getSpecialLocation(juce::File::tempDirectory)
                             .getChildFile("silverdaw_no_such_decode.wav.tmp");
    missing.deleteFile();
    require(!decodedWavIsUsable(missing), "a missing decode must be rejected");

    const auto garbage = juce::File::getSpecialLocation(juce::File::tempDirectory)
                             .getChildFile("silverdaw_garbage_decode.wav.tmp");
    garbage.deleteFile();
    garbage.replaceWithText("this is not audio");
    require(!decodedWavIsUsable(garbage), "a non-audio file must be rejected");
    garbage.deleteFile();
}

} // namespace

void addDecodedCacheTests(std::vector<TestCase>& tests)
{
    tests.push_back({"decode keeps audio when the reader over-reports its length",
                     testShortTailKeepsTheDecodedAudio});
    tests.push_back({"decode writes every sample when the reader is accurate", testAFullReadWritesEverySample});
    tests.push_back({"decode rejects a badly truncated read", testATruncatedDecodeFallsBelowTheThreshold});
    tests.push_back({"decode validation accepts a wav staged under a .wav.tmp name",
                     testAUsableWavIsAcceptedOnATmpStagingPath});
    tests.push_back({"decode validation rejects a missing or non-audio file", testAnUnusableDecodeIsRejected});
}

} // namespace silverdaw::tests
