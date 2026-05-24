#include "WarpProcessor.h"

#include <algorithm>

namespace silverdaw
{

using RubberBand::RubberBandStretcher;

WarpProcessor::WarpProcessor(int numChannelsArg, double sampleRateArg,
                             RubberBandStretcher::Options modeOptions)
    : numChannels(juce::jmax(1, numChannelsArg)), sampleRate(sampleRateArg)
{
    // Compose the option flags: caller-supplied mode (R2 Faster / R2 Finer / R3)
    // OR'd with our own per-build defaults. Real-time mode is mandatory —
    // we'd starve the audio callback in offline mode. PitchHighConsistency
    // lets us change pitch live without artefacts on the order of a few
    // samples; the cost is one extra `setPitchScale()` per block, which
    // is measured in tens of nanoseconds.
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
    // The stretcher may demand up to one block of source per output
    // block at ratio 1.0 — at our 0.25..4.0 ratio cap it can demand up
    // to 4× that. Pre-allocate the worst case so `process()` never
    // touches the heap.
    const int worstCase = juce::jmax(maxBlockSamples * 4, 1024);
    if (worstCase <= allocatedBlockSamples) return;
    allocatedBlockSamples = worstCase;
    sourceScratch.assign(static_cast<size_t>(numChannels), std::vector<float>(static_cast<size_t>(worstCase)));
    sourceScratchPtrs.resize(static_cast<size_t>(numChannels));
    for (int c = 0; c < numChannels; ++c)
    {
        sourceScratchPtrs[c] = sourceScratch[c].data();
    }
}

void WarpProcessor::doReset()
{
    if (stretcher == nullptr) return;
    stretcher->reset();
    // After a reset, `getPreferredStartPad()` is the number of source
    // samples the stretcher would like to see before any real output is
    // consumed. We feed silence here as a conservative pre-roll; once
    // real audio starts flowing through `process()` the stretcher
    // settles into its steady-state. A future revision can replace this
    // with actual source pre-roll for click-free seek-to-mid-clip play.
    const int pad = static_cast<int>(stretcher->getPreferredStartPad());
    if (pad > 0 && allocatedBlockSamples > 0)
    {
        // Zero the scratch in place (the constructor already zeroed it
        // once, but a previous run may have left non-silence behind).
        for (int c = 0; c < numChannels; ++c)
        {
            std::fill(sourceScratch[c].begin(), sourceScratch[c].begin() + std::min(pad, allocatedBlockSamples), 0.0f);
        }
        int remaining = pad;
        while (remaining > 0)
        {
            const int chunk = std::min(remaining, allocatedBlockSamples);
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
        // Rubber Band's time-ratio is output / input; Silverdaw's
        // `tempoRatio` is project / source (i.e. how much faster the
        // clip plays). Invert.
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

    if (resetPending.exchange(false, std::memory_order_acq_rel))
    {
        doReset();
    }
    if (seekPending.exchange(false, std::memory_order_acq_rel))
    {
        nextSourceSample = pendingSourceSeek.load(std::memory_order_acquire);
        doReset();
    }

    applyPendingParams();

    int produced = 0;
    int safety = 0;
    while (produced < numOutputSamples && safety++ < 64)
    {
        const int available = static_cast<int>(stretcher->available());
        if (available > 0)
        {
            const int want = std::min(available, numOutputSamples - produced);
            // Offset each pre-allocated output-pointer by `produced` so
            // successive pulls concatenate cleanly into the output block.
            for (int c = 0; c < numChannels; ++c) outputScratchPtrs[c] = output[c] + produced;
            const size_t got = stretcher->retrieve(outputScratchPtrs.data(), static_cast<size_t>(want));
            produced += static_cast<int>(got);
            continue;
        }

        // Stretcher needs more source. Ask the callback for one block's
        // worth at the current source position; the callback is
        // responsible for placing exactly `chunk` samples per channel
        // into the supplied scratch pointers.
        const int chunk = std::min(allocatedBlockSamples, 1024);
        readSource(sourceScratchPtrs.data(), nextSourceSample, chunk);
        stretcher->process(sourceScratchPtrs.data(), static_cast<size_t>(chunk), false);
        nextSourceSample += chunk;
    }

    // Fill any remaining output with silence — this should be rare
    // (only during start-up before the stretcher has primed) but keeps
    // the contract honest.
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
