#include "VocalDenoiser.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include <rnnoise.h>
#include <samplerate.h>

namespace silverdaw
{
namespace
{

// RNNoise only operates at this rate; everything is resampled to it and back.
constexpr double kRnnoiseRate = 48000.0;

// RNNoise consumes/produces samples scaled to the 16-bit PCM magnitude range
// rather than [-1, 1], so float audio is multiplied by this on the way in and
// divided by it on the way out.
constexpr float kPcmScale = 32768.0F;

// One-shot mono resample via libsamplerate. Returns false (leaving `out` empty)
// on any error so the caller can fall back to the dry signal. Best-quality SINC
// is used because this is offline and the wet path makes two passes (up + down).
bool resampleMono(const float* in, int inLen, double inRate, double outRate,
                  std::vector<float>& out)
{
    if (in == nullptr || inLen <= 0)
    {
        out.clear();
        return false;
    }
    if (inRate == outRate)
    {
        out.assign(in, in + inLen);
        return true;
    }

    const double ratio = outRate / inRate;
    const auto outCap = static_cast<long>(std::ceil(static_cast<double>(inLen) * ratio)) + 16L;
    out.assign(static_cast<size_t>(outCap), 0.0F);

    SRC_DATA data{};
    data.data_in = in;
    data.input_frames = inLen;
    data.data_out = out.data();
    data.output_frames = outCap;
    data.src_ratio = ratio;
    data.end_of_input = 1;

    if (src_simple(&data, SRC_SINC_BEST_QUALITY, 1) != 0)
    {
        out.clear();
        return false;
    }
    out.resize(static_cast<size_t>(std::max<long>(0L, data.output_frames_gen)));
    return ! out.empty();
}

// Runs a 48 kHz mono signal through RNNoise, writing the denoised result into
// `dst` (same length as `src`). RNNoise delays its output by exactly one frame
// (FRAME_SIZE samples); that delay is compensated here by feeding one extra
// frame of zeros to flush the tail and then dropping the leading frame, so
// `dst[k]` is time-aligned with `src[k]`. Returns false on allocation failure.
bool denoiseMono48k(const std::vector<float>& src, std::vector<float>& dst,
                    const std::function<void(double)>& onFrameProgress)
{
    DenoiseState* st = rnnoise_create(nullptr);
    if (st == nullptr) return false;

    const int frame = rnnoise_get_frame_size();
    if (frame <= 0)
    {
        rnnoise_destroy(st);
        return false;
    }

    const size_t n = src.size();
    const auto frameSz = static_cast<size_t>(frame);
    // Process whole frames only, with one extra frame past the input to flush
    // the network's one-frame delayed tail. Rounding up to a frame boundary
    // keeps every write inside `delayed`.
    const size_t inFrames = (n + frameSz - 1) / frameSz; // ceil(n / frameSz)
    const size_t totalFrames = inFrames + 1;             // + flush frame
    const size_t padded = totalFrames * frameSz;

    std::vector<float> in(frameSz, 0.0F);
    std::vector<float> out(frameSz, 0.0F);
    std::vector<float> delayed(padded, 0.0F);

    size_t frameIdx = 0;
    // Report at most ~100 times to keep the progress callback cheap.
    const size_t reportEvery = std::max<size_t>(1, totalFrames / 100);
    for (size_t pos = 0; pos < padded; pos += frameSz)
    {
        for (size_t i = 0; i < frameSz; ++i)
        {
            const size_t idx = pos + i;
            in[i] = (idx < n) ? src[idx] * kPcmScale : 0.0F;
        }
        rnnoise_process_frame(st, out.data(), in.data());
        for (size_t i = 0; i < frameSz; ++i)
            delayed[pos + i] = out[i] / kPcmScale;
        ++frameIdx;
        if (onFrameProgress && (frameIdx % reportEvery == 0))
            onFrameProgress(static_cast<double>(frameIdx) / static_cast<double>(totalFrames));
    }
    rnnoise_destroy(st);

    dst.assign(n, 0.0F);
    for (size_t i = 0; i < n; ++i)
        dst[i] = delayed[i + frameSz]; // discard the one-frame leading delay
    return true;
}

} // namespace

void VocalDenoiser::process(juce::AudioBuffer<float>& buffer, double sampleRate, float wetAmount,
                            const std::function<void(double)>& onProgress)
{
    const float wet = std::clamp(wetAmount, 0.0F, 1.0F);
    if (wet <= 0.0F) return;

    const int numCh = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();
    if (numCh <= 0 || numSamples <= 0) return;
    if (! (sampleRate > 0.0) || ! std::isfinite(sampleRate)) return;

    // A stray NaN/Inf would poison the resampler and the network, so clear it
    // before anything reads the samples.
    for (int ch = 0; ch < numCh; ++ch)
    {
        float* d = buffer.getWritePointer(ch);
        for (int i = 0; i < numSamples; ++i)
            if (! std::isfinite(d[i]))
                d[i] = 0.0F;
    }

    // Produce the processed channels into a scratch buffer first and only commit
    // once every channel succeeds, so a mid-way failure never leaves the stem
    // half-processed.
    juce::AudioBuffer<float> result(numCh, numSamples);
    for (int ch = 0; ch < numCh; ++ch)
    {
        // Each channel owns an equal slice of the 0..1 progress range; the
        // denoise loop fills the middle of that slice (resampling brackets it).
        const double chBase = static_cast<double>(ch) / static_cast<double>(numCh);
        const double chSpan = 1.0 / static_cast<double>(numCh);

        std::vector<float> up;
        if (! resampleMono(buffer.getReadPointer(ch), numSamples, sampleRate, kRnnoiseRate, up))
            return;

        std::vector<float> denoised;
        const auto frameProgress = onProgress
            ? std::function<void(double)>(
                  [&](double f) { onProgress(chBase + chSpan * (0.05 + 0.90 * f)); })
            : std::function<void(double)>{};
        if (! denoiseMono48k(up, denoised, frameProgress))
            return;

        // Blend wet/dry at 48 kHz, before the single down-resample, so the dry
        // and wet components share one identical filter path and cannot comb.
        for (size_t i = 0; i < up.size(); ++i)
            up[i] += wet * (denoised[i] - up[i]);

        std::vector<float> down;
        if (! resampleMono(up.data(), static_cast<int>(up.size()), kRnnoiseRate, sampleRate, down))
            return;

        // Round-trip resampling can land a sample or two short/long; copy what we
        // have and zero-pad the remainder to keep the stem length exact.
        float* dst = result.getWritePointer(ch);
        const int avail = std::min(numSamples, static_cast<int>(down.size()));
        for (int i = 0; i < avail; ++i) dst[i] = down[static_cast<size_t>(i)];
        for (int i = avail; i < numSamples; ++i) dst[i] = 0.0F;

        if (onProgress) onProgress(chBase + chSpan);
    }

    for (int ch = 0; ch < numCh; ++ch)
        buffer.copyFrom(ch, 0, result, ch, 0, numSamples);
}

} // namespace silverdaw
