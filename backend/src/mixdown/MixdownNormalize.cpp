#include "MixdownNormalize.h"

#include "MixdownBroadcast.h"
#include "MixdownExport.h"
#include "MixdownGraph.h"

#include <algorithm>
#include <cmath>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

namespace silverdaw::mixdown_normalize
{

using mixdown_bridge::broadcastProgress;
using mixdown_dither::kLsb16f;
using mixdown_dither::nextUniform;
using mixdown_graph::kBlockFrames;
using mixdown_graph::kOutputChannels;

namespace
{
// Min spacing between progress envelopes so the bridge isn't flooded.
constexpr int kProgressMinIntervalMs = 50;

Pass2Result fail(MixdownFailureCode code, const juce::String& message)
{
    Pass2Result r;
    r.ok = false;
    r.code = code;
    r.message = message;
    return r;
}
} // anonymous namespace

Pass2Result runNormalizePass2(const juce::File& f32TmpFile,
                              const juce::File& tmpFile,
                              const MixdownOptions& options,
                              const juce::File& lameApp,
                              int chosenBitDepth,
                              bool wantFloatWav,
                              double appliedGainDb,
                              LoudnessAnalyzer& analyzer,
                              mixdown_dither::Xorshift32& rngL,
                              mixdown_dither::Xorshift32& rngR,
                              BridgeServer& bridge,
                              std::atomic<bool>& cancelFlag)
{
    // Open a reader on the f32 intermediate. Bytes are
    // already on disk after the pass-1 writer.reset().
    //
    // The intermediate is always a WAV float file we wrote in pass 1,
    // but its name carries a ".f32.tmp" suffix so the final output
    // rename stays atomic. AudioFormatManager::createReaderFor() gates
    // on the file extension, and ".tmp" matches no registered format —
    // it would return nullptr and fail every Normalize export. Open it
    // with the WAV reader directly since we know exactly what it is.
    juce::WavAudioFormat wavReadback;
    std::unique_ptr<juce::AudioFormatReader> p2Reader;
    if (auto f32In = f32TmpFile.createInputStream())
        p2Reader.reset(wavReadback.createReaderFor(f32In.release(), /*deleteWhenDone*/ true));
    if (p2Reader == nullptr)
    {
        f32TmpFile.deleteFile();
        return fail(MixdownFailureCode::Io,
                    "Pass 2: could not open intermediate file for read-back.");
    }

    // Open the user-chosen final writer on `tmpFile`.
    std::unique_ptr<juce::OutputStream> p2Stream =
        std::make_unique<juce::FileOutputStream>(tmpFile);
    if (! static_cast<juce::FileOutputStream*>(p2Stream.get())->openedOk())
    {
        p2Reader.reset();
        f32TmpFile.deleteFile();
        return fail(MixdownFailureCode::Io,
                    "Pass 2: cannot open output for writing: " + tmpFile.getFullPathName());
    }
    auto p2Opts = juce::AudioFormatWriterOptions{}
                      .withSampleRate(static_cast<double>(options.outputSampleRate))
                      .withNumChannels(kOutputChannels)
                      .withBitsPerSample(chosenBitDepth)
                      .withSampleFormat(wantFloatWav
                                            ? juce::AudioFormatWriterOptions::SampleFormat::floatingPoint
                                            : juce::AudioFormatWriterOptions::SampleFormat::integral);
    std::unique_ptr<juce::AudioFormatWriter> p2Writer =
        mixdown_export::createOutputWriter(options.format, p2Opts, lameApp,
                                           options.metadata, options.bitrateKbps, p2Stream);
    if (p2Writer == nullptr)
    {
        p2Stream.reset();
        tmpFile.deleteFile();
        f32TmpFile.deleteFile();
        return fail(MixdownFailureCode::Io,
                    juce::String("Pass 2: failed to create final writer (bitDepth=")
                        + juce::String(chosenBitDepth) + ").");
    }
    const bool p2DitherActive = options.dither
                                && chosenBitDepth == 16
                                && ! p2Writer->isFloatingPoint();

    // Linear gain factor for pass 2's per-sample multiply.
    const float linGain = static_cast<float>(std::pow(10.0, appliedGainDb / 20.0));

    Pass2Result result;
    result.ok = true;

    // Stream the intermediate in kBlockFrames chunks.
    juce::AudioBuffer<float> p2Buf(kOutputChannels, kBlockFrames);
    const juce::int64 totalP2Frames = p2Reader->lengthInSamples;
    juce::int64 p2Pos = 0;
    int64_t p2OutputFramesWritten = 0;
    int64_t p2LastProgressMs = juce::Time::getMillisecondCounter();
    while (p2Pos < totalP2Frames)
    {
        if (cancelFlag.load())
        {
            p2Writer.reset();
            tmpFile.deleteFile();
            f32TmpFile.deleteFile();
            return fail(MixdownFailureCode::Cancelled, "Cancelled.");
        }
        const int chunk = static_cast<int>(
            std::min<juce::int64>(kBlockFrames, totalP2Frames - p2Pos));
        p2Buf.clear(0, chunk);
        if (! p2Reader->read(&p2Buf, 0, chunk, p2Pos, true, true))
        {
            p2Writer.reset();
            tmpFile.deleteFile();
            f32TmpFile.deleteFile();
            return fail(MixdownFailureCode::Io, "Pass 2: read failure.");
        }

        // Apply gain + track post-gain peak and clip count.
        // Clip count vs the integer ceiling matters when the
        // analytical TP_final exceeds 0 dBFS; we surface it
        // as a separate metric in the loudness report.
        float* pL = p2Buf.getWritePointer(0);
        float* pR = p2Buf.getWritePointer(1);
        for (int i = 0; i < chunk; ++i)
        {
            pL[i] *= linGain;
            pR[i] *= linGain;
            const float aL = std::abs(pL[i]);
            const float aR = std::abs(pR[i]);
            const float maxA = juce::jmax(aL, aR);
            if (maxA > result.postGainPeakAmp)
                result.postGainPeakAmp = maxA;
            if (aL > 1.0F || aR > 1.0F) ++result.clippedSamples;
        }

        if (p2DitherActive)
        {
            for (int i = 0; i < chunk; ++i)
            {
                const float dL = (nextUniform(rngL) + nextUniform(rngL) - 1.0f) * kLsb16f;
                const float dR = (nextUniform(rngR) + nextUniform(rngR) - 1.0f) * kLsb16f;
                pL[i] += dL;
                pR[i] += dR;
            }
        }
        const float* writePtrs[kOutputChannels] = { pL, pR };
        if (! p2Writer->writeFromFloatArrays(writePtrs, kOutputChannels, chunk))
        {
            p2Writer.reset();
            tmpFile.deleteFile();
            f32TmpFile.deleteFile();
            return fail(MixdownFailureCode::Io, "Pass 2: writer failed mid-stream.");
        }
        p2Pos += chunk;
        p2OutputFramesWritten += chunk;

        const auto now = juce::Time::getMillisecondCounter();
        if (now - p2LastProgressMs >= kProgressMinIntervalMs)
        {
            const double pct = 46.0 + (static_cast<double>(p2Pos)
                                       / static_cast<double>(juce::jmax<juce::int64>(1, totalP2Frames)))
                                       * 44.0;
            broadcastProgress(bridge, pct, "normalize-pass2");
            p2LastProgressMs = now;
        }
    }
    broadcastProgress(bridge, 90.0, "normalize-pass2");
    p2Writer.reset();
    // The final on-disk file length is what pass 2 wrote.
    result.outputFramesWritten = p2OutputFramesWritten;
    // Recompute the analytical final loudness with the gain
    // that was actually applied.
    result.finalLoudness = analyzer.computeForLinearGainDb(appliedGainDb);

    // Intermediate is consumed; drop it before the user's
    // file is committed so a crash after this point doesn't
    // leak the sidecar.
    f32TmpFile.deleteFile();
    broadcastProgress(bridge, 92.0, "finalize");
    return result;
}

} // namespace silverdaw::mixdown_normalize
