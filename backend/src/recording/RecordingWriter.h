#pragma once

#include <juce_audio_formats/juce_audio_formats.h>

#include <memory>

namespace silverdaw::recording
{

/**
 * Owns the growing WAV for one recording. The capture callback hands blocks to
 * the ThreadedWriter, which does every disk write on its own background thread,
 * so no file I/O happens on the audio thread.
 *
 * Finishing is atomic in the sense that matters: a recording that fails is
 * deleted rather than left on disk to be presented as a usable file.
 */
class RecordingWriter
{
  public:
    RecordingWriter();
    ~RecordingWriter();

    RecordingWriter(const RecordingWriter&) = delete;
    RecordingWriter& operator=(const RecordingWriter&) = delete;

    /** `expectedSamples` is the longest this recording may run, used for the
     *  free-space check before a note is captured. */
    bool start(const juce::File& file, double sampleRate, int channels,
               juce::int64 expectedSamples, juce::String& error);

    juce::AudioFormatWriter::ThreadedWriter* getThreadedWriter() noexcept { return writer.get(); }

    /** Flushes and closes; returns false if nothing was written or the file is
     *  unusable, in which case the file is removed. */
    bool finish();

    /** Discards the recording and deletes the file. */
    void abort();

    juce::File getFile() const { return outputFile; }
    double getSampleRate() const noexcept { return writerSampleRate; }
    int getChannelCount() const noexcept { return writerChannels; }

  private:
    juce::TimeSliceThread backgroundThread{"Silverdaw recording writer"};
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> writer;
    juce::File outputFile;
    double writerSampleRate = 0.0;
    int writerChannels = 0;
};

} // namespace silverdaw::recording
