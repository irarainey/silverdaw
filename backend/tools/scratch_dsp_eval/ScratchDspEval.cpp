#include "VinylScratchProcessor.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <iterator>
#include <vector>

namespace
{
constexpr double kSampleRate = 48000.0;
constexpr int kBlockSize = 512;
constexpr int kBlocks = 4000;

double percentile(const std::vector<double>& sorted, double fraction)
{
    const auto index = static_cast<std::size_t>(
        fraction * static_cast<double>(sorted.size() - 1));
    return sorted[index];
}
} // namespace

int main()
{
    constexpr int sourceSamples = static_cast<int>(kSampleRate * 12.0);
    juce::AudioBuffer<float> source(2, sourceSamples);
    for (int sample = 0; sample < sourceSamples; ++sample)
    {
        const double time = sample / kSampleRate;
        const float value = static_cast<float>(
            0.35 * std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 * time)
            + 0.15 * std::sin(2.0 * juce::MathConstants<double>::pi * 7000.0 * time));
        source.setSample(0, sample, value);
        source.setSample(1, sample, -value);
    }

    juce::AudioBuffer<float> output(2, kBlockSize);
    silverdaw::VinylScratchProcessor processor;
    processor.prepare(kSampleRate);
    processor.reset(sourceSamples / 2.0, 1.0);

    constexpr double rates[] = {
        1.0, 2.0, 4.0, 8.0, 4.0, 2.0, 1.0, 0.0,
        -1.0, -2.0, -4.0, -8.0, -4.0, -2.0, -1.0, 0.0
    };
    std::vector<double> blockTimesMs;
    blockTimesMs.reserve(kBlocks);
    double peak = 0.0;
    int overruns = 0;
    const double blockBudgetMs = 1000.0 * kBlockSize / kSampleRate;

    for (int block = 0; block < kBlocks; ++block)
    {
        processor.setTargetRate(rates[(block / 20) % std::size(rates)]);
        processor.setTargetGain((block / 200) % 2 == 0 ? 1.0F : 0.2F);
        output.clear();

        const auto start = std::chrono::steady_clock::now();
        processor.process(source, output, 0, kBlockSize);
        const auto end = std::chrono::steady_clock::now();
        const double elapsedMs =
            std::chrono::duration<double, std::milli>(end - start).count();
        blockTimesMs.push_back(elapsedMs);
        if (elapsedMs > blockBudgetMs) ++overruns;

        for (int channel = 0; channel < output.getNumChannels(); ++channel)
        {
            for (int sample = 0; sample < output.getNumSamples(); ++sample)
            {
                const double value = output.getSample(channel, sample);
                if (!std::isfinite(value))
                {
                    std::cerr << "non-finite output\n";
                    return 1;
                }
                peak = std::max(peak, std::abs(value));
            }
        }
    }

    std::sort(blockTimesMs.begin(), blockTimesMs.end());
    const double medianMs = percentile(blockTimesMs, 0.5);
    const double p95Ms = percentile(blockTimesMs, 0.95);
    const double maximumMs = blockTimesMs.back();
    std::cout << "blocks=" << kBlocks << " blockSize=" << kBlockSize
              << " medianMs=" << medianMs << " p95Ms=" << p95Ms
              << " maxMs=" << maximumMs << " budgetMs=" << blockBudgetMs
              << " overruns=" << overruns << " peak=" << peak << '\n';

    if (peak > 1.05)
    {
        std::cerr << "output exceeded expected range\n";
        return 1;
    }
    if (p95Ms > 2.0)
    {
        std::cerr << "p95 processing time exceeded 2 ms prototype ceiling\n";
        return 1;
    }
    if (overruns > 0)
    {
        std::cerr << "prototype exceeded the callback budget\n";
        return 1;
    }
    return 0;
}
