#include "WarpProcessor.h"

#include <algorithm>

namespace silverdaw
{

using RubberBand::RubberBandStretcher;

WarpProcessor::WarpProcessor(int numChannelsArg, double sampleRateArg,
                             RubberBandStretcher::Options modeOptions)
    : numChannels(juce::jmax(1, numChannelsArg)), sampleRate(sampleRateArg)
{
    // Real-time mode is mandatory for the audio callback; high-consistency pitch avoids live artefacts.
    const auto options = modeOptions
                       | RubberBandStretcher::OptionProcessRealTime
                       | RubberBandStretcher::OptionPitchHighConsistency;
    stretcher = std::make_unique<RubberBandStretcher>(static_cast<size_t>(sampleRate),
                                                       static_cast<size_t>(numChannels),
                                                       options,
                                                       1.0, // initial time ratio (output / input)
                                                       1.0  // initial pitch scale
    );
    outputScratchPtrs.resize(static_cast<size_t>(numChannels));
    doReset();
}

WarpProcessor::~WarpProcessor() = default;

void WarpProcessor::prepareToPlay(int maxBlockSamples)
{
    // Pre-allocate the 0.25-ratio worst case so `process()` never touches the heap.
    const int worstCase = juce::jmax(maxBlockSamples * 4, 1024);
    if (worstCase <= allocatedBlockSamples) return;
    allocatedBlockSamples = worstCase;
    sourceScratch.assign(static_cast<size_t>(numChannels), std::vector<float>(static_cast<size_t>(worstCase)));
    discardScratch.assign(static_cast<size_t>(numChannels), std::vector<float>(static_cast<size_t>(worstCase)));
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
            const int chunk = std::min(remaining, allocatedBlockSamples);
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
        doReset();
    }
    else if (wantsReset)
    {
        doReset();
    }

    int produced = 0;
    int safety = 0;
    while (produced < numOutputSamples && safety++ < 64)
    {
        const int available = static_cast<int>(stretcher->available());
        if (available > 0 && outputDelayToDiscard > 0)
        {
            const int drop = std::min({available, outputDelayToDiscard, allocatedBlockSamples});
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

        const int chunk = std::min(allocatedBlockSamples, 1024);
        readSource(sourceScratchPtrs.data(), nextSourceSample, chunk);
        stretcher->process(sourceScratchPtrs.data(), static_cast<size_t>(chunk), false);
        nextSourceSample += chunk;
    }

    // Silence-fill rare priming shortfalls to keep the output contract stable.
    if (produced < numOutputSamples)
    {
        for (int c = 0; c < numChannels; ++c)
        {
            std::fill(output[c] + produced, output[c] + numOutputSamples, 0.0f);
        }
    }
    return produced;
}

} // namespace silverdaw
