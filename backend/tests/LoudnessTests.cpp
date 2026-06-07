// Loudness: BS.1770 integrated LUFS / true-peak measurement, gain shifting,
// and the supported-sample-rate guard.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "EdgeFadeSnapshot.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MixdownEngine.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "SharedFx.h"
#include "ToneEq.h"
#include "ValueTreeJson.h"
#include "WarpProcessor.h"

#include <atomic>
#include <array>
#include <chrono>
#include <cmath>
#include <exception>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#include <juce_events/juce_events.h>

namespace silverdaw::tests
{
namespace
{

void testLoudnessAnalyzerSilence()
{
        silverdaw::LoudnessAnalyzer ana(48000.0);
        const int n = 48000;
        std::vector<float> z(n, 0.0F);
        const float* ch[2] = { z.data(), z.data() };
        ana.process(ch, 2, n);
        const auto r = ana.finalize();
        require(r.silent || r.unmeasurable,
                "silence should be reported silent or unmeasurable");
        require(! std::isfinite(r.integratedLufs), "silent integrated LUFS must be -inf");
}

void testLoudnessAnalyzerSineHits23()
{
        // 1 kHz stereo sine, RMS-calibrated to -26 dBFS per channel.
        // Stereo channel summation in BS.1770 (G_L=G_R=1.0) adds +3 dB
        // → integrated should land at ~-23 LUFS.
        silverdaw::LoudnessAnalyzer ana(48000.0);
        const int n = 48000 * 3;
        const double rmsLin = std::pow(10.0, -26.0 / 20.0);
        const double ampLin = rmsLin * std::sqrt(2.0); // sine peak from RMS
        std::vector<float> sine(n);
        const double twoPiF = 2.0 * 3.14159265358979323846 * 1000.0 / 48000.0;
        for (int i = 0; i < n; ++i)
            sine[static_cast<size_t>(i)] = static_cast<float>(ampLin * std::sin(twoPiF * i));
        const float* ch[2] = { sine.data(), sine.data() };
        ana.process(ch, 2, n);
        const auto r = ana.finalize();
        require(! r.silent && ! r.unmeasurable, "loud sine must be measurable");
        require(std::abs(r.integratedLufs - (-23.0)) < 0.5,
                "integrated LUFS for -26 dBFS stereo sine should be ~-23");
        require(r.gatedBlockCount > 0, "should have at least one gated block");
}

void testLoudnessAnalyzerGainShift()
{
        // computeForLinearGainDb shifts both integrated LUFS and TP by
        // the applied gain (within rounding).
        silverdaw::LoudnessAnalyzer ana(48000.0);
        const int n = 48000 * 3;
        const double rmsLin = std::pow(10.0, -26.0 / 20.0);
        const double ampLin = rmsLin * std::sqrt(2.0);
        std::vector<float> sine(n);
        const double twoPiF = 2.0 * 3.14159265358979323846 * 1000.0 / 48000.0;
        for (int i = 0; i < n; ++i)
            sine[static_cast<size_t>(i)] = static_cast<float>(ampLin * std::sin(twoPiF * i));
        const float* ch[2] = { sine.data(), sine.data() };
        ana.process(ch, 2, n);
        const auto base = ana.finalize();
        const auto plus6 = ana.computeForLinearGainDb(6.0);
        require(std::abs((plus6.integratedLufs - base.integratedLufs) - 6.0) < 0.1,
                "+6 dB gain should shift integrated LUFS by ~+6");
        require(std::abs((plus6.truePeakDbtp - base.truePeakDbtp) - 6.0) < 0.01,
                "+6 dB gain should shift true peak by exactly +6 dB");
}

void testLoudnessAnalyzerSampleRateGuard()
{
        bool threw = false;
        try { silverdaw::LoudnessAnalyzer bad(96000.0); }
        catch (const juce::String&) { threw = true; }
        require(threw, "LoudnessAnalyzer must reject non-standard sample rates");
}

} // namespace

void addLoudnessTests(std::vector<TestCase>& tests)
{
    tests.push_back({"LoudnessAnalyzer reports silent for digital silence", testLoudnessAnalyzerSilence});
    tests.push_back({"LoudnessAnalyzer measures -26 dBFS stereo sine as ~-23 LUFS", testLoudnessAnalyzerSineHits23});
    tests.push_back({"LoudnessAnalyzer computeForLinearGainDb shifts LUFS & TP by gain", testLoudnessAnalyzerGainShift});
    tests.push_back({"LoudnessAnalyzer rejects non-standard sample rates", testLoudnessAnalyzerSampleRateGuard});
}

} // namespace silverdaw::tests
