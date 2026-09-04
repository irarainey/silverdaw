#include "RecordingWriter.h"

#include "Log.h"

namespace silverdaw::recording
{
namespace
{
constexpr int kBitsPerSample = 24;
constexpr int kFifoBlocks = 32768;
// Refuse to start unless the volume can hold the recording plus this margin, so
// a full disk is reported before the performance rather than after it.
constexpr juce::int64 kFreeSpaceMarginBytes = 32 * 1024 * 1024;
} // namespace

RecordingWriter::RecordingWriter() = default;

RecordingWriter::~RecordingWriter()
{
    writer.reset();
    backgroundThread.stopThread(2000);
}

bool RecordingWriter::start(const juce::File& file, double sampleRate, int channels,
                            juce::int64 expectedSamples, juce::String& error)
{
    if (sampleRate <= 0.0 || channels <= 0)
    {
        error = "The audio input is not usable";
        return false;
    }

    const auto parent = file.getParentDirectory();
    if (! parent.isDirectory() && parent.createDirectory().failed())
    {
        error = "Could not create the recordings folder";
        return false;
    }

    const auto bytesNeeded = expectedSamples * channels * (kBitsPerSample / 8) + kFreeSpaceMarginBytes;
    const auto bytesFree = parent.getBytesFreeOnVolume();
    if (bytesFree > 0 && bytesFree < bytesNeeded)
    {
        error = "There is not enough free disk space to record";
        return false;
    }

    file.deleteFile();
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
    if (stream == nullptr)
    {
        error = "Could not create the recording file";
        return false;
    }

    juce::WavAudioFormat wav;
    const auto options = juce::AudioFormatWriterOptions{}
                             .withSampleRate(sampleRate)
                             .withNumChannels(channels)
                             .withBitsPerSample(kBitsPerSample);
    std::unique_ptr<juce::AudioFormatWriter> formatWriter(wav.createWriterFor(stream, options));
    if (formatWriter == nullptr)
    {
        error = "Could not create the recording file";
        return false;
    }

    backgroundThread.startThread(juce::Thread::Priority::high);
    writer = std::make_unique<juce::AudioFormatWriter::ThreadedWriter>(
        formatWriter.release(), backgroundThread, kFifoBlocks);
    outputFile = file;
    writerSampleRate = sampleRate;
    writerChannels = channels;
    return true;
}

bool RecordingWriter::finish()
{
    if (writer == nullptr) return false;
    writer.reset();
    backgroundThread.stopThread(2000);

    if (! outputFile.existsAsFile() || outputFile.getSize() <= 0)
    {
        log::warn("recording", "recording produced no file: " + outputFile.getFullPathName());
        outputFile.deleteFile();
        return false;
    }
    return true;
}

void RecordingWriter::abort()
{
    writer.reset();
    backgroundThread.stopThread(2000);
    outputFile.deleteFile();
    outputFile = {};
}

} // namespace silverdaw::recording
