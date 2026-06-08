#include "LoudnessAnalyzer.h"

#include "Log.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace silverdaw
{

namespace
{
constexpr double kBs1770Calibration = -0.691; // LUFS offset
constexpr double kAbsoluteGateLufs   = -70.0;
constexpr double kRelativeGateLu     = -10.0;
constexpr double kBlockMs            = 400.0;
constexpr double kStepMs             = 100.0;
} // namespace

LoudnessAnalyzer::Biquad LoudnessAnalyzer::designKHighShelf(double fs)
{
    // Runtime design avoids coefficient-table drift from the BS.1770 prototypes.
    constexpr double f0 = 1681.974450955533;
    constexpr double G  = 3.999843853973347; // dB
    constexpr double Q  = 0.7071752369554196;
    const double K  = std::tan(juce::MathConstants<double>::pi * f0 / fs);
    const double Vh = std::pow(10.0, G / 20.0);
    const double Vb = std::pow(Vh, 0.4996667741545416);
    const double K2 = K * K;
    const double a0 = 1.0 + K / Q + K2;
    Biquad b{};
    b.b0 = (Vh + Vb * K / Q + K2) / a0;
    b.b1 = 2.0 * (K2 - Vh) / a0;
    b.b2 = (Vh - Vb * K / Q + K2) / a0;
    b.a1 = 2.0 * (K2 - 1.0) / a0;
    b.a2 = (1.0 - K / Q + K2) / a0;
    return b;
}

LoudnessAnalyzer::Biquad LoudnessAnalyzer::designKHighPass(double fs)
{
    // Same BS.1770 runtime-design path as the pre-filter stage.
    constexpr double f0 = 38.13547087602444;
    constexpr double Q  = 0.5003270373238773;
    const double K  = std::tan(juce::MathConstants<double>::pi * f0 / fs);
    const double K2 = K * K;
    const double a0 = 1.0 + K / Q + K2;
    Biquad b{};
    b.b0 = 1.0 / a0;
    b.b1 = -2.0 / a0;
    b.b2 = 1.0 / a0;
    b.a1 = 2.0 * (K2 - 1.0) / a0;
    b.a2 = (1.0 - K / Q + K2) / a0;
    return b;
}

LoudnessAnalyzer::LoudnessAnalyzer(double sampleRate)
{
    if (std::abs(sampleRate - 44100.0) > 0.5
        && std::abs(sampleRate - 48000.0) > 0.5)
    {
        throw juce::String(
            "LoudnessAnalyzer: only 44.1 / 48 kHz supported (got " +
            juce::String(sampleRate, 1) + ").");
    }
    sampleRate_ = sampleRate;
    hsFilter_ = designKHighShelf(sampleRate);
    hpFilter_ = designKHighPass(sampleRate);
    blockFrames_ = static_cast<int>(std::round(kBlockMs * 0.001 * sampleRate));
    stepFrames_  = static_cast<int>(std::round(kStepMs  * 0.001 * sampleRate));
    blockMs_.reserve(4096); // ~7 minutes of project at 100 ms step
    buildTruePeakFir();
}

void LoudnessAnalyzer::reset()
{
    hsFilter_.resetState();
    hpFilter_.resetState();
    frameCursor_ = 0;
    totalFramesSeen_ = 0;
    sumSqL_ = sumSqR_ = 0.0;
    subBlocks_.fill(SubBlock{});
    subBlockWriteIdx_ = 0;
    subBlocksFilled_ = 0;
    blockMs_.clear();
    ungatedRunningSum_ = 0.0;
    ungatedRunningCount_ = 0;
    truePeak_.maxAbs = 0.0;
    truePeak_.history[0].fill(0.0F);
    truePeak_.history[1].fill(0.0F);
    truePeak_.writeIdx = {0, 0};
    finalized_ = false;
    cachedResult_ = {};
}

void LoudnessAnalyzer::buildTruePeakFir()
{
    // Deterministic 4× FIR is accurate enough for true-peak back-off without IIR ringing.
    constexpr int N = TruePeak::kTapsPerPhase;
    constexpr int P = TruePeak::kPhases;
    const double centre = (N - 1) * 0.5;
    for (int p = 0; p < P; ++p)
    {
        const double delta = static_cast<double>(p) / static_cast<double>(P);
        double sumW = 0.0;
        std::array<double, N> raw{};
        for (int n = 0; n < N; ++n)
        {
            const double x = (static_cast<double>(n) - centre - delta);
            const double sinc = (std::abs(x) < 1e-9)
                                    ? 1.0
                                    : std::sin(juce::MathConstants<double>::pi * x)
                                          / (juce::MathConstants<double>::pi * x);
            const double w = 0.5 - 0.5 * std::cos(2.0 * juce::MathConstants<double>::pi
                                                   * static_cast<double>(n)
                                                   / static_cast<double>(N - 1));
            const double v = sinc * w;
            raw[static_cast<size_t>(n)] = v;
            sumW += v;
        }
        // Preserve DC through each phase.
        const double norm = sumW == 0.0 ? 1.0 : 1.0 / sumW;
        for (int n = 0; n < N; ++n)
        {
            truePeak_.coefs[static_cast<size_t>(p * N + n)] =
                static_cast<float>(raw[static_cast<size_t>(n)] * norm);
        }
    }
}

void LoudnessAnalyzer::pushTruePeakSample(int ch, float sample)
{
    auto& hist = truePeak_.history[static_cast<size_t>(ch)];
    auto& widx = truePeak_.writeIdx[static_cast<size_t>(ch)];
    hist[static_cast<size_t>(widx)] = sample;
    widx = (widx + 1) % TruePeak::kTapsPerPhase;
    constexpr int N = TruePeak::kTapsPerPhase;
    constexpr int P = TruePeak::kPhases;
    double localMax = std::abs(static_cast<double>(sample));
    for (int p = 0; p < P; ++p)
    {
        double acc = 0.0;
        for (int n = 0; n < N; ++n)
        {
            const int idx = (widx + n) % N; // widx now points to oldest
            acc += static_cast<double>(hist[static_cast<size_t>(idx)])
                   * static_cast<double>(truePeak_.coefs[static_cast<size_t>(p * N + n)]);
        }
        const double a = std::abs(acc);
        if (a > localMax) localMax = a;
    }
    if (localMax > truePeak_.maxAbs) truePeak_.maxAbs = localMax;
}

void LoudnessAnalyzer::pushKWeightedSample(double xL, double xR)
{
    const float yL_hs = hsFilter_.process(0, xL);
    const float yL    = hpFilter_.process(0, static_cast<double>(yL_hs));
    const float yR_hs = hsFilter_.process(1, xR);
    const float yR    = hpFilter_.process(1, static_cast<double>(yR_hs));
    sumSqL_ += static_cast<double>(yL) * static_cast<double>(yL);
    sumSqR_ += static_cast<double>(yR) * static_cast<double>(yR);
    ++frameCursor_;
    ++totalFramesSeen_;
    if (frameCursor_ >= stepFrames_) closeBlock();
}

void LoudnessAnalyzer::closeBlock()
{
    // Four 100 ms sub-blocks form the BS.1770 400 ms block with 75% overlap.
    if (stepFrames_ <= 0) return;
    subBlocks_[static_cast<size_t>(subBlockWriteIdx_)] = { sumSqL_, sumSqR_ };
    subBlockWriteIdx_ = (subBlockWriteIdx_ + 1) % kSubBlocksPerBlock;
    ++subBlocksFilled_;
    if (subBlocksFilled_ >= kSubBlocksPerBlock)
    {
        double sL = 0.0, sR = 0.0;
        for (int i = 0; i < kSubBlocksPerBlock; ++i)
        {
            sL += subBlocks_[static_cast<size_t>(i)].sumSqL;
            sR += subBlocks_[static_cast<size_t>(i)].sumSqR;
        }
        const double blockLen = static_cast<double>(kSubBlocksPerBlock)
                                * static_cast<double>(stepFrames_);
        const double msL = sL / blockLen;
        const double msR = sR / blockLen;
        const double msSum = msL + msR;
        blockMs_.push_back(msSum);
        ungatedRunningSum_ += msSum;
        ++ungatedRunningCount_;
    }
    frameCursor_ = 0;
    sumSqL_ = 0.0;
    sumSqR_ = 0.0;
}

void LoudnessAnalyzer::process(const float* const* channels, int numChannels, int numFrames)
{
    if (numFrames <= 0 || numChannels <= 0 || finalized_) return;
    const float* const chL = channels[0];
    const float* const chR = numChannels >= 2 ? channels[1] : channels[0];
    for (int i = 0; i < numFrames; ++i)
    {
        const double xL = static_cast<double>(chL[i]);
        const double xR = static_cast<double>(chR[i]);
        pushKWeightedSample(xL, xR);
        // True-peak operates on the linear (un-K-weighted) signal.
        pushTruePeakSample(0, chL[i]);
        pushTruePeakSample(1, chR[i]);
    }
}

LoudnessAnalyzer::Result LoudnessAnalyzer::finalize()
{
    if (finalized_) return cachedResult_;
    // Short-program fallback: use one whole-signal block if no 400 ms block closed.
    if (blockMs_.empty() && totalFramesSeen_ > 0)
    {
        double sL = sumSqL_;
        double sR = sumSqR_;
        for (int i = 0; i < subBlocksFilled_ && i < kSubBlocksPerBlock; ++i)
        {
            sL += subBlocks_[static_cast<size_t>(i)].sumSqL;
            sR += subBlocks_[static_cast<size_t>(i)].sumSqR;
        }
        const double invN = 1.0 / static_cast<double>(totalFramesSeen_);
        const double msSum = sL * invN + sR * invN;
        blockMs_.push_back(msSum);
        ungatedRunningSum_ += msSum;
        ++ungatedRunningCount_;
    }

    Result r{};
    const double tpDbtp = truePeak_.maxAbs > 0.0
                              ? 20.0 * std::log10(truePeak_.maxAbs)
                              : -std::numeric_limits<double>::infinity();
    r.truePeakDbtp = tpDbtp;

    if (blockMs_.empty() || ungatedRunningCount_ == 0)
    {
        r.silent = true;
        r.integratedLufs = -std::numeric_limits<double>::infinity();
        r.gatedBlockCount = 0;
        finalized_ = true;
        cachedResult_ = r;
        return r;
    }

    auto msFromLufs = [](double lufs) -> double
    {
        return std::pow(10.0, (lufs - kBs1770Calibration) / 10.0);
    };
    const double absGateMs = msFromLufs(kAbsoluteGateLufs);
    double sumAbs = 0.0;
    int countAbs = 0;
    for (double ms : blockMs_)
    {
        if (ms >= absGateMs)
        {
            sumAbs += ms;
            ++countAbs;
        }
    }
    if (countAbs == 0)
    {
        // Fall back to ungated mean so below-gate material still gets a number.
        r.unmeasurable = true;
        const double meanAll = ungatedRunningSum_ / static_cast<double>(ungatedRunningCount_);
        r.integratedLufs = meanAll > 0.0
                               ? kBs1770Calibration + 10.0 * std::log10(meanAll)
                               : -std::numeric_limits<double>::infinity();
        r.gatedBlockCount = 0;
        finalized_ = true;
        cachedResult_ = r;
        return r;
    }
    const double meanAbs = sumAbs / static_cast<double>(countAbs);
    const double relGateLufs = kBs1770Calibration + 10.0 * std::log10(meanAbs) + kRelativeGateLu;
    const double relGateMs = msFromLufs(relGateLufs);
    double sumRel = 0.0;
    int countRel = 0;
    for (double ms : blockMs_)
    {
        if (ms >= absGateMs && ms >= relGateMs)
        {
            sumRel += ms;
            ++countRel;
        }
    }
    if (countRel == 0)
    {
        // If the relative gate excludes everything, use the absolute-gated mean.
        r.gatedBlockCount = countAbs;
        r.integratedLufs = kBs1770Calibration + 10.0 * std::log10(meanAbs);
    }
    else
    {
        r.gatedBlockCount = countRel;
        const double meanRel = sumRel / static_cast<double>(countRel);
        r.integratedLufs = kBs1770Calibration + 10.0 * std::log10(meanRel);
    }
    finalized_ = true;
    cachedResult_ = r;
    return r;
}

LoudnessAnalyzer::Result LoudnessAnalyzer::computeForLinearGainDb(double gainDb) const
{
    // Gates are not gain-invariant, so scale stored MS values and re-gate.
    Result r{};
    const double linearGain = std::pow(10.0, gainDb / 10.0); // for MS (energy)
    r.truePeakDbtp = cachedResult_.silent
                         ? -std::numeric_limits<double>::infinity()
                         : cachedResult_.truePeakDbtp + gainDb;
    if (cachedResult_.silent || blockMs_.empty())
    {
        r.silent = true;
        r.integratedLufs = -std::numeric_limits<double>::infinity();
        return r;
    }
    auto msFromLufs = [](double lufs) -> double
    {
        return std::pow(10.0, (lufs - kBs1770Calibration) / 10.0);
    };
    const double absGateMs = msFromLufs(kAbsoluteGateLufs);
    double sumAbs = 0.0;
    int countAbs = 0;
    for (double ms : blockMs_)
    {
        const double scaled = ms * linearGain;
        if (scaled >= absGateMs)
        {
            sumAbs += scaled;
            ++countAbs;
        }
    }
    if (countAbs == 0)
    {
        r.unmeasurable = true;
        const double meanAll =
            (ungatedRunningSum_ * linearGain) / static_cast<double>(ungatedRunningCount_);
        r.integratedLufs = meanAll > 0.0
                               ? kBs1770Calibration + 10.0 * std::log10(meanAll)
                               : -std::numeric_limits<double>::infinity();
        return r;
    }
    const double meanAbs = sumAbs / static_cast<double>(countAbs);
    const double relGateLufs = kBs1770Calibration + 10.0 * std::log10(meanAbs) + kRelativeGateLu;
    const double relGateMs = msFromLufs(relGateLufs);
    double sumRel = 0.0;
    int countRel = 0;
    for (double ms : blockMs_)
    {
        const double scaled = ms * linearGain;
        if (scaled >= absGateMs && scaled >= relGateMs)
        {
            sumRel += scaled;
            ++countRel;
        }
    }
    if (countRel == 0)
    {
        r.gatedBlockCount = countAbs;
        r.integratedLufs = kBs1770Calibration + 10.0 * std::log10(meanAbs);
    }
    else
    {
        r.gatedBlockCount = countRel;
        const double meanRel = sumRel / static_cast<double>(countRel);
        r.integratedLufs = kBs1770Calibration + 10.0 * std::log10(meanRel);
    }
    return r;
}

} // namespace silverdaw
