// BsRoformerSpectral: the host-side STFT/iSTFT front/back-end around the 4-stem
// BS-RoFormer rhythm ONNX core. Unlike the vocal pack, the model applies the
// mask in-graph and returns the masked spectrogram, so `synthesizeStem` takes a
// per-stem complex spectrum directly. The decisive property is the analysis →
// identity synthesis ROUND-TRIP: feeding the analysed spectrum straight back
// (i.e. an in-graph identity mask) must reconstruct the input chunk interior,
// proving the framing, [channel,freq,frame] layout, iFFT and envelope-normalised
// overlap-add all agree with the model's export contract.

#include "TestRegistry.h"

#include "BsRoformerSpectral.h"

#include <cmath>
#include <vector>

namespace silverdaw::tests
{
namespace
{
using Spec = silverdaw::BsRoformerSpectral;
constexpr double kTwoPi = 2.0 * 3.14159265358979323846;

std::vector<float> makeChunk()
{
    std::vector<float> chunk(static_cast<size_t>(Spec::kChunkFloats));
    const int n = Spec::kChunkSamples;
    for (int i = 0; i < n; ++i)
    {
        chunk[static_cast<size_t>(i)] =
            0.6f * static_cast<float>(std::sin(kTwoPi * 220.0 * i / 44100.0));
        chunk[static_cast<size_t>(n + i)] =
            0.4f * static_cast<float>(std::sin(kTwoPi * 660.0 * i / 44100.0));
    }
    return chunk;
}

double rms(const float* d, int start, int count)
{
    double s = 0.0;
    for (int i = start; i < start + count; ++i) s += static_cast<double>(d[i]) * d[i];
    return std::sqrt(s / count);
}

void testIdentityRoundTrips()
{
    Spec sp;
    const auto chunk = makeChunk();

    std::vector<float> specReal(static_cast<size_t>(Spec::kSpecFloats), 0.0f);
    std::vector<float> specImag(static_cast<size_t>(Spec::kSpecFloats), 0.0f);
    sp.analyze(chunk.data(), specReal.data(), specImag.data());

    // Feed the analysed spectrum straight back (in-graph identity mask).
    std::vector<float> out(static_cast<size_t>(Spec::kChunkFloats), 0.0f);
    sp.synthesizeStem(specReal.data(), specImag.data(), out.data());

    const int n = Spec::kChunkSamples;
    const int guard = Spec::kNFft;
    const int count = n - 2 * guard;
    require(count > 44100, "interior region is sizable");

    for (int ch = 0; ch < Spec::kChannels; ++ch)
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
                "identity STFT/iSTFT reconstructs the chunk interior");
    }
}

void testZeroSpectrumSilences()
{
    Spec sp;
    std::vector<float> specReal(static_cast<size_t>(Spec::kSpecFloats), 0.0f);
    std::vector<float> specImag(static_cast<size_t>(Spec::kSpecFloats), 0.0f);
    std::vector<float> out(static_cast<size_t>(Spec::kChunkFloats), 1.0f);
    sp.synthesizeStem(specReal.data(), specImag.data(), out.data());

    const int n = Spec::kChunkSamples;
    require(rms(out.data(), Spec::kNFft, n - 2 * Spec::kNFft) < 1.0e-4,
            "a zero spectrum yields silence");
}

void testHalfSpectrumHalvesAmplitude()
{
    Spec sp;
    const auto chunk = makeChunk();
    std::vector<float> specReal(static_cast<size_t>(Spec::kSpecFloats), 0.0f);
    std::vector<float> specImag(static_cast<size_t>(Spec::kSpecFloats), 0.0f);
    sp.analyze(chunk.data(), specReal.data(), specImag.data());
    for (auto& v : specReal) v *= 0.5f;
    for (auto& v : specImag) v *= 0.5f;

    std::vector<float> out(static_cast<size_t>(Spec::kChunkFloats), 0.0f);
    sp.synthesizeStem(specReal.data(), specImag.data(), out.data());

    const int n = Spec::kChunkSamples;
    const int guard = Spec::kNFft;
    const int count = n - 2 * guard;
    const double in0 = rms(chunk.data(), guard, count);
    const double out0 = rms(out.data(), guard, count);
    require(std::abs(out0 - 0.5 * in0) / (0.5 * in0) < 0.02,
            "halving the spectrum halves the reconstructed amplitude");
}

} // namespace

void addBsRoformerSpectralTests(std::vector<TestCase>& tests)
{
    tests.push_back({"BsRoformerSpectral identity round-trips", testIdentityRoundTrips});
    tests.push_back({"BsRoformerSpectral zero spectrum silences", testZeroSpectrumSilences});
    tests.push_back({"BsRoformerSpectral 0.5 spectrum halves amplitude", testHalfSpectrumHalvesAmplitude});
}

} // namespace silverdaw::tests
