// MelRoformerSpectral: the host-side STFT/iSTFT front/back-end around the
// Mel-Band RoFormer vocal ONNX core. The decisive property is the analysis →
// identity-mask synthesis ROUND-TRIP: with a unit (1+0i) mask the pipeline must
// reconstruct the input chunk in its interior (away from the reflect-padded
// edges), proving the framing, packing, complex-mask multiply, iFFT and
// envelope-normalised overlap-add all agree with the model's export contract.

#include "TestRegistry.h"

#include "MelRoformerSpectral.h"

#include <cmath>
#include <vector>

namespace silverdaw::tests
{
namespace
{

constexpr double kTwoPi = 2.0 * 3.14159265358979323846;

// One planar-stereo chunk filled with two distinct tones (so a channel swap or
// packing error shows up as cross-talk, not a silent pass).
std::vector<float> makeChunk()
{
    std::vector<float> chunk(static_cast<size_t>(silverdaw::MelRoformerSpectral::kChunkFloats));
    const int n = silverdaw::MelRoformerSpectral::kChunkSamples;
    for (int i = 0; i < n; ++i)
    {
        chunk[static_cast<size_t>(i)] = 0.6f * std::sin(kTwoPi * 220.0 * i / 44100.0);
        chunk[static_cast<size_t>(n + i)] = 0.4f * std::sin(kTwoPi * 660.0 * i / 44100.0);
    }
    return chunk;
}

double rms(const float* d, int start, int count)
{
    double s = 0.0;
    for (int i = start; i < start + count; ++i) s += static_cast<double>(d[i]) * d[i];
    return std::sqrt(s / count);
}

void testIdentityMaskRoundTrips()
{
    silverdaw::MelRoformerSpectral sp;
    const auto chunk = makeChunk();

    std::vector<float> stft(static_cast<size_t>(silverdaw::MelRoformerSpectral::kTensorFloats), 0.0f);
    sp.analyze(chunk.data(), stft.data());

    // Identity complex mask (1 + 0i) on every bin.
    std::vector<float> masks(static_cast<size_t>(silverdaw::MelRoformerSpectral::kTensorFloats), 0.0f);
    for (size_t i = 0; i < masks.size(); i += 2) masks[i] = 1.0f;

    std::vector<float> out(static_cast<size_t>(silverdaw::MelRoformerSpectral::kChunkFloats), 0.0f);
    sp.synthesize(stft.data(), masks.data(), out.data());

    // Compare the interior (skip the first/last ~n_fft samples where the reflect
    // pad and partial-overlap envelope differ) per channel.
    const int n = silverdaw::MelRoformerSpectral::kChunkSamples;
    const int guard = silverdaw::MelRoformerSpectral::kNFft;
    const int count = n - 2 * guard;
    require(count > 44100, "interior region is sizable");

    for (int ch = 0; ch < silverdaw::MelRoformerSpectral::kChannels; ++ch)
    {
        const float* in = chunk.data() + static_cast<size_t>(ch) * n;
        const float* re = out.data() + static_cast<size_t>(ch) * n;
        double err = 0.0;
        for (int i = guard; i < n - guard; ++i)
        {
            const double d = static_cast<double>(in[i]) - re[i];
            err += d * d;
        }
        const double errRms = std::sqrt(err / count);
        const double sigRms = rms(in, guard, count);
        require(sigRms > 0.0, "channel has signal");
        require(errRms / sigRms < 1.0e-3,
                "identity-mask STFT/iSTFT reconstructs the chunk interior");
    }
}

void testZeroMaskSilences()
{
    silverdaw::MelRoformerSpectral sp;
    const auto chunk = makeChunk();
    std::vector<float> stft(static_cast<size_t>(silverdaw::MelRoformerSpectral::kTensorFloats), 0.0f);
    sp.analyze(chunk.data(), stft.data());

    std::vector<float> masks(static_cast<size_t>(silverdaw::MelRoformerSpectral::kTensorFloats), 0.0f);
    std::vector<float> out(static_cast<size_t>(silverdaw::MelRoformerSpectral::kChunkFloats), 1.0f);
    sp.synthesize(stft.data(), masks.data(), out.data());

    const int n = silverdaw::MelRoformerSpectral::kChunkSamples;
    require(rms(out.data(), silverdaw::MelRoformerSpectral::kNFft,
               n - 2 * silverdaw::MelRoformerSpectral::kNFft) < 1.0e-4,
            "a zero mask yields silence");
}

void testHalfMaskHalvesAmplitude()
{
    silverdaw::MelRoformerSpectral sp;
    const auto chunk = makeChunk();
    std::vector<float> stft(static_cast<size_t>(silverdaw::MelRoformerSpectral::kTensorFloats), 0.0f);
    sp.analyze(chunk.data(), stft.data());

    std::vector<float> masks(static_cast<size_t>(silverdaw::MelRoformerSpectral::kTensorFloats), 0.0f);
    for (size_t i = 0; i < masks.size(); i += 2) masks[i] = 0.5f; // real 0.5 gain
    std::vector<float> out(static_cast<size_t>(silverdaw::MelRoformerSpectral::kChunkFloats), 0.0f);
    sp.synthesize(stft.data(), masks.data(), out.data());

    const int n = silverdaw::MelRoformerSpectral::kChunkSamples;
    const int guard = silverdaw::MelRoformerSpectral::kNFft;
    const int count = n - 2 * guard;
    const double in0 = rms(chunk.data(), guard, count);
    const double out0 = rms(out.data(), guard, count);
    require(std::abs(out0 - 0.5 * in0) / (0.5 * in0) < 0.02,
            "a real 0.5 mask halves the reconstructed amplitude");
}

} // namespace

void addMelRoformerSpectralTests(std::vector<TestCase>& tests)
{
    tests.push_back({"MelRoformerSpectral identity mask round-trips", testIdentityMaskRoundTrips});
    tests.push_back({"MelRoformerSpectral zero mask silences", testZeroMaskSilences});
    tests.push_back({"MelRoformerSpectral 0.5 mask halves amplitude", testHalfMaskHalvesAmplitude});
}

} // namespace silverdaw::tests
