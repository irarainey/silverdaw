#include "WarpProcessor.h"

#include <algorithm>

namespace silverdaw
{

using RubberBand::RubberBandStretcher;

WarpProcessor::WarpProcessor(int numChannelsArg, double sampleRateArg,
                             RubberBandStretcher::Options modeOptions,
                             double initialPitchScale)
    : numChannels(juce::jlimit(1, kMaxChannels, numChannelsArg)), sampleRate(sampleRateArg)
{
    const double clampedPitchScale = juce::jlimit(0.25, 4.0, initialPitchScale);
    const auto options = realtimeOptionsFor(modeOptions, clampedPitchScale);
    canChangePitchOption =
        (modeOptions & RubberBandStretcher::OptionEngineFiner) == 0;
    highConsistencyPitch = !canChangePitchOption ||
        (options & RubberBandStretcher::OptionPitchHighConsistency) != 0;
    pendingPitchScale.store(clampedPitchScale, std::memory_order_relaxed);
    appliedPitchScale = clampedPitchScale;
    stretcher = std::make_unique<RubberBandStretcher>(static_cast<size_t>(sampleRate),
                                                       static_cast<size_t>(numChannels),
                                                       options,
                                                       1.0, // initial time ratio (output / input)
                                                       clampedPitchScale
    );
    stretcher->setMaxProcessSize(static_cast<size_t>(kProcessFeedSamples));
    outputScratchPtrs.resize(static_cast<size_t>(numChannels));
    doReset();
}

WarpProcessor::~WarpProcessor() = default;

RubberBandStretcher::Options WarpProcessor::realtimeOptionsFor(
    RubberBandStretcher::Options modeOptions, double initialPitchScale) noexcept
{
    auto options = modeOptions | RubberBandStretcher::OptionProcessRealTime;
    const bool finerEngine =
        (modeOptions & RubberBandStretcher::OptionEngineFiner) != 0;
    if (finerEngine || std::abs(initialPitchScale - 1.0) > 1.0e-4)
        options |= RubberBandStretcher::OptionPitchHighConsistency;
    return options;
}

void WarpProcessor::prepareToPlay(int maxBlockSamples)
{
    juce::ignoreUnused(maxBlockSamples);
    if (allocatedBlockSamples == kProcessFeedSamples) return;
    allocatedBlockSamples = kProcessFeedSamples;
    sourceScratch.assign(static_cast<size_t>(numChannels),
                         std::vector<float>(static_cast<size_t>(kProcessFeedSamples)));
    discardScratch.assign(static_cast<size_t>(numChannels),
                          std::vector<float>(static_cast<size_t>(kProcessFeedSamples)));
    sourceScratchPtrs.resize(static_cast<size_t>(numChannels));
    discardScratchPtrs.resize(static_cast<size_t>(numChannels));
    for (int c = 0; c < numChannels; ++c)
    {
        sourceScratchPtrs[c] = sourceScratch[c].data();
        discardScratchPtrs[c] = discardScratch[c].data();
    }
    doReset();
}

void WarpProcessor::doReset()
{
    if (stretcher == nullptr) return;
    stretcher->reset();
    // Feed Rubber Band's start pad and discard its priming delay after reset/seek.
    const int pad = static_cast<int>(stretcher->getPreferredStartPad());
    outputDelayToDiscard = static_cast<int>(stretcher->getStartDelay());
    if (pad > 0 && allocatedBlockSamples > 0)
    {
        int remaining = pad;
        while (remaining > 0)
        {
            const int chunk = std::min({remaining, allocatedBlockSamples,
                                        kProcessFeedSamples});
            for (int c = 0; c < numChannels; ++c)
            {
                std::fill(sourceScratch[c].begin(), sourceScratch[c].begin() + chunk, 0.0f);
            }
            stretcher->process(sourceScratchPtrs.data(), static_cast<size_t>(chunk), false);
            remaining -= chunk;
        }
    }
}

void WarpProcessor::applyPendingParams() noexcept
{
    if (stretcher == nullptr) return;
    const double tr = pendingTempoRatio.load(std::memory_order_acquire);
    if (tr != appliedTempoRatio)
    {
        // Rubber Band wants output/input, the inverse of Silverdaw's project/source ratio.
        stretcher->setTimeRatio(1.0 / tr);
        appliedTempoRatio = tr;
    }
    const double ps = pendingPitchScale.load(std::memory_order_acquire);
    if (ps != appliedPitchScale)
    {
        if (canChangePitchOption && !highConsistencyPitch)
        {
            stretcher->setPitchOption(RubberBandStretcher::OptionPitchHighConsistency);
            highConsistencyPitch = true;
        }
        stretcher->setPitchScale(ps);
        appliedPitchScale = ps;
    }
}

bool WarpProcessor::isActive() const noexcept
{
    const double tr = pendingTempoRatio.load(std::memory_order_acquire);
    const double ps = pendingPitchScale.load(std::memory_order_acquire);
    return std::abs(tr - 1.0) > 1e-4 || std::abs(ps - 1.0) > 1e-4;
}

int WarpProcessor::process(float* const* output, int numOutputSamples,
                           const std::function<void(float* const*, juce::int64, int)>& readSource)
{
    if (stretcher == nullptr || numOutputSamples <= 0 || allocatedBlockSamples == 0)
    {
        for (int c = 0; c < numChannels; ++c)
        {
            std::fill(output[c], output[c] + numOutputSamples, 0.0f);
        }
        return 0;
    }

    applyPendingParams();

    const bool wantsSeek = seekPending.exchange(false, std::memory_order_acq_rel);
    const bool wantsReset = resetPending.exchange(false, std::memory_order_acq_rel);
    if (wantsSeek)
    {
        nextSourceSample = pendingSourceSeek.load(std::memory_order_acquire);
        logicalSourceSample = static_cast<double>(nextSourceSample);
        doReset();
    }
    else if (wantsReset)
    {
        doReset();
    }

    int produced = 0;
    const int feedChunk = std::min(allocatedBlockSamples, kProcessFeedSamples);
    const auto expectedInput = static_cast<int64_t>(
        std::ceil(static_cast<double>(numOutputSamples) * appliedTempoRatio));
    const auto primingInput = static_cast<int64_t>(
        std::ceil(static_cast<double>(outputDelayToDiscard) * appliedTempoRatio));
    const auto maxInputToFeed =
        expectedInput + primingInput + static_cast<int64_t>(feedChunk) * 2;
    int64_t inputFed = 0;
    int64_t iterations = 0;
    const int64_t maxIterations =
        static_cast<int64_t>(numOutputSamples) + maxInputToFeed
        + outputDelayToDiscard + 8;
    while (produced < numOutputSamples && iterations++ < maxIterations)
    {
        const int available = static_cast<int>(stretcher->available());
        if (available > 0 && outputDelayToDiscard > 0)
        {
            const int drop =
                std::min({available, outputDelayToDiscard, kProcessFeedSamples});
            stretcher->retrieve(discardScratchPtrs.data(), static_cast<size_t>(drop));
            outputDelayToDiscard -= drop;
            continue;
        }
        if (available > 0)
        {
            const int want = std::min(available, numOutputSamples - produced);
            for (int c = 0; c < numChannels; ++c) outputScratchPtrs[c] = output[c] + produced;
            const size_t got = stretcher->retrieve(outputScratchPtrs.data(), static_cast<size_t>(want));
            produced += static_cast<int>(got);
            continue;
        }

        const auto required = static_cast<int64_t>(stretcher->getSamplesRequired());
        const auto remainingInput = maxInputToFeed - inputFed;
        if (required <= 0 || remainingInput <= 0) break;
        const int sourceSamples =
            static_cast<int>(std::min({required, remainingInput,
                                       static_cast<int64_t>(feedChunk)}));
        readSource(sourceScratchPtrs.data(), nextSourceSample, sourceSamples);
        stretcher->process(sourceScratchPtrs.data(), static_cast<size_t>(sourceSamples), false);
        nextSourceSample += sourceSamples;
        inputFed += sourceSamples;
    }

    logicalSourceSample += static_cast<double>(numOutputSamples) * appliedTempoRatio;

    // Silence-fill rare priming shortfalls to keep the output contract stable.
    if (produced < numOutputSamples)
    {
        for (int c = 0; c < numChannels; ++c)
        {
            std::fill(output[c] + produced, output[c] + numOutputSamples, 0.0f);
        }
        // Do not carry delayed output across the inserted silence. Resume from the
        // audible timeline cursor rather than Rubber Band's read-ahead frontier.
        nextSourceSample = static_cast<juce::int64>(std::llround(logicalSourceSample));
        doReset();
    }
    return produced;
}

} // namespace silverdaw
