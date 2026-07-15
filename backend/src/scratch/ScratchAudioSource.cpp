#include "ScratchAudioSource.h"
#include "ScratchPatternEvaluator.h"

#include <cmath>
#include <thread>

namespace silverdaw::scratch
{
namespace
{
std::int64_t clampSourceSampleIndex(int sourceSamples, std::int64_t sampleIndex) noexcept
{
    if (sourceSamples <= 0)
        return 0;
    return juce::jlimit<std::int64_t>(0, static_cast<std::int64_t>(sourceSamples - 1),
                                      sampleIndex);
}
} // namespace

ScratchAudioSource::ScratchAudioSource() = default;

ScratchAudioSource::ScratchAudioSource(
    std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
    double preparedSampleRate)
    : audio(std::move(preparedAudio)),
      sourceSampleRate(juce::jmax(1.0, preparedSampleRate))
{
    active.store(audio != nullptr && audio->getNumSamples() > 0,
                 std::memory_order_release);
}

void ScratchAudioSource::waitForCallbackQuiescence() const noexcept
{
    // Spin-yield until no callback is in-flight.  Called only from message/
    // control threads — never from the audio callback.
    while (callbackInFlight.load(std::memory_order_acquire) > 0)
        std::this_thread::yield();
}

void ScratchAudioSource::activate(
    std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
    double preparedSampleRate)
{
    // 1. Gate: prevent new callbacks from doing work.
    active.store(false, std::memory_order_release);
    // 2. Wait for any in-flight callback to finish.
    waitForCallbackQuiescence();
    // 3. Now safe to mutate non-atomic fields.
    audio = std::move(preparedAudio);
    sourceSampleRate = juce::jmax(1.0, preparedSampleRate);
    sourceSamplesPerOutputSample = sourceSampleRate / outputSampleRate;
    motorPlaying.store(false, std::memory_order_release);
    platterTouched.store(false, std::memory_order_release);
    manualSemanticRate.store(0.0, std::memory_order_release);
    manualRateUntilOutputSample.store(0, std::memory_order_release);
    targetGain.store(1.0F, std::memory_order_release);
    outputSampleCounter.store(0, std::memory_order_release);
    pendingSeekSourceSample.store(0, std::memory_order_release);
    publishedSourcePosition.store(0.0, std::memory_order_release);
    publishedSemanticRate.store(0.0, std::memory_order_release);
    sourceEndReached.store(false, std::memory_order_release);
    seekGeneration.fetch_add(1, std::memory_order_acq_rel);
    VinylScratchProcessor::Settings settings;
    settings.maxAbsRate = juce::jmin(32.0, 8.0 * sourceSamplesPerOutputSample);
    processor.prepare(outputSampleRate, settings);
    processor.reset(0.0, 0.0, 1.0F);
    appliedSeekGeneration = seekGeneration.load(std::memory_order_acquire);
    // 4. Re-enable.
    active.store(audio != nullptr && audio->getNumSamples() > 0,
                 std::memory_order_release);
}

void ScratchAudioSource::deactivate() noexcept
{
    // 1. Gate: stop callbacks from doing work.
    active.store(false, std::memory_order_release);
    // 2. Wait for any in-flight callback.
    waitForCallbackQuiescence();
    // 3. Silence atomics — do NOT release the audio buffer here;
    //    a subsequent activate() or destructor handles that.
    motorPlaying.store(false, std::memory_order_release);
    platterTouched.store(false, std::memory_order_release);
    targetGain.store(0.0F, std::memory_order_release);
    publishedSourcePosition.store(0.0, std::memory_order_release);
    publishedSemanticRate.store(0.0, std::memory_order_release);
    sourceEndReached.store(false, std::memory_order_release);
}

void ScratchAudioSource::prepareToPlay(int samplesPerBlockExpected, double newOutputSampleRate)
{
    juce::ignoreUnused(samplesPerBlockExpected);
    outputSampleRate = juce::jmax(1.0, newOutputSampleRate);
    sourceSamplesPerOutputSample = sourceSampleRate / outputSampleRate;
    VinylScratchProcessor::Settings settings;
    settings.maxAbsRate = juce::jmin(32.0, 8.0 * sourceSamplesPerOutputSample);
    processor.prepare(outputSampleRate, settings);
    processor.reset(
        static_cast<double>(pendingSeekSourceSample.load(std::memory_order_acquire)),
        0.0,
        targetGain.load(std::memory_order_acquire));
    appliedSeekGeneration = seekGeneration.load(std::memory_order_acquire);
    sourceEndReached.store(false, std::memory_order_release);
}

void ScratchAudioSource::releaseResources()
{
}

void ScratchAudioSource::getNextAudioBlock(const juce::AudioSourceChannelInfo& info)
{
    if (info.buffer == nullptr || info.numSamples <= 0)
        return;

    // Acquire the in-flight guard BEFORE checking active.
    callbackInFlight.fetch_add(1, std::memory_order_acq_rel);

    if (!active.load(std::memory_order_acquire)
        || audio == nullptr || audio->getNumChannels() <= 0 || audio->getNumSamples() <= 0)
    {
        info.clearActiveBufferRegion();
        callbackInFlight.fetch_sub(1, std::memory_order_release);
        return;
    }

    const auto requestedSeekGeneration = seekGeneration.load(std::memory_order_acquire);
    if (requestedSeekGeneration != appliedSeekGeneration)
    {
        processor.reset(
            static_cast<double>(pendingSeekSourceSample.load(std::memory_order_acquire)),
            0.0,
            targetGain.load(std::memory_order_acquire));
        appliedSeekGeneration = requestedSeekGeneration;
    }

    const auto blockStart = outputSampleCounter.load(std::memory_order_relaxed);
    const auto* replay = replaySnapshot.load(std::memory_order_acquire);
    if (replay != nullptr)
    {
        const auto timeUs = static_cast<std::int64_t>(
            static_cast<double>(replayOutputSamples) * 1000000.0 / outputSampleRate);
        const auto replayDurationUs = replay->durationUs();
        replayNormalized.store(
            replayDurationUs > 0
                ? juce::jlimit(0.0, 1.0, static_cast<double>(timeUs)
                                             / static_cast<double>(replayDurationUs))
                : 0.0,
            std::memory_order_release);
        const auto current = ScratchPatternEvaluator::evaluate(*replay, timeUs);
        if (current.beyondEnd)
        {
            replaySnapshot.store(nullptr, std::memory_order_release);
            info.clearActiveBufferRegion();
            motorPlaying.store(false, std::memory_order_release);
            publishedSemanticRate.store(0.0, std::memory_order_release);
            sourceEndReached.store(true, std::memory_order_release);
            callbackInFlight.fetch_sub(1, std::memory_order_release);
            return;
        }

        const auto midpointUs = timeUs + static_cast<std::int64_t>(
            static_cast<double>(info.numSamples) * 500000.0 / outputSampleRate);
        const auto evaluation = ScratchPatternEvaluator::evaluate(
            *replay, juce::jmin(replay->durationUs() - 1, midpointUs));

        processor.setManualWeightEngaged(false);
        processor.setTargetRate(evaluation.playbackRate * sourceSamplesPerOutputSample);
        processor.setTargetGain(static_cast<float>(evaluation.crossfaderGain));
        processor.process(*audio, *info.buffer, info.startSample, info.numSamples);
        replayOutputSamples += info.numSamples;
        outputSampleCounter.store(blockStart + info.numSamples, std::memory_order_release);
        publishedSourcePosition.store(processor.getSourcePosition(), std::memory_order_release);
        publishedSemanticRate.store(
            juce::jlimit(-8.0, 8.0, evaluation.playbackRate),
            std::memory_order_release);
        callbackInFlight.fetch_sub(1, std::memory_order_release);
        return;
    }

    double semanticRate = 0.0;
    const bool playing = motorPlaying.load(std::memory_order_acquire);
    const bool touched = platterTouched.load(std::memory_order_acquire);
    if (touched && blockStart < manualRateUntilOutputSample.load(std::memory_order_acquire))
    {
        semanticRate = manualSemanticRate.load(std::memory_order_acquire);
    }
    else if (playing && !touched)
    {
        semanticRate = 1.0;
    }

    // Platter inertia: heavier rate smoothing while the platter is held smooths
    // twitchy fast jog moves on light controllers; the untouched (release/motor)
    // path keeps the fast snap so letting go still resumes speed instantly.
    processor.setManualWeightEngaged(touched);
    processor.setTargetRate(semanticRate * sourceSamplesPerOutputSample);
    processor.setTargetGain(targetGain.load(std::memory_order_acquire));
    processor.process(*audio, *info.buffer, info.startSample, info.numSamples);

    const auto sourceSamples = audio->getNumSamples();
    const auto lastSourceSample = juce::jmax(0, sourceSamples - 1);
    const auto sourcePosition = juce::jlimit(
        0.0, static_cast<double>(lastSourceSample), processor.getSourcePosition());
    const bool reachedForwardEnd =
        playing && !touched && sourcePosition >= static_cast<double>(lastSourceSample);

    const auto nextOutputSample = blockStart + info.numSamples;
    outputSampleCounter.store(nextOutputSample, std::memory_order_release);
    publishedSourcePosition.store(sourcePosition, std::memory_order_release);
    const auto semanticRateOut =
        sourceSamplesPerOutputSample > 0.0
            ? (reachedForwardEnd ? 0.0
                                 : processor.getCurrentRate() / sourceSamplesPerOutputSample)
            : 0.0;
    publishedSemanticRate.store(
        juce::jlimit(-8.0, 8.0, semanticRateOut),
        std::memory_order_release);
    if (reachedForwardEnd)
        sourceEndReached.store(true, std::memory_order_release);

    callbackInFlight.fetch_sub(1, std::memory_order_release);
}

void ScratchAudioSource::setPlaying(bool shouldPlay) noexcept
{
    motorPlaying.store(shouldPlay, std::memory_order_release);
    if (shouldPlay)
        sourceEndReached.store(false, std::memory_order_release);
}

void ScratchAudioSource::setTouched(bool isTouched) noexcept
{
    platterTouched.store(isTouched, std::memory_order_release);
    if (!isTouched)
    {
        manualRateUntilOutputSample.store(0, std::memory_order_release);
    }
}

void ScratchAudioSource::setManualRate(double semanticRate, double holdSeconds) noexcept
{
    manualSemanticRate.store(juce::jlimit(-8.0, 8.0, semanticRate), std::memory_order_release);
    const auto holdSamples = static_cast<std::int64_t>(
        juce::jmax(0.0, holdSeconds) * outputSampleRate);
    manualRateUntilOutputSample.store(
        outputSampleCounter.load(std::memory_order_acquire) + holdSamples,
        std::memory_order_release);
}

void ScratchAudioSource::setGain(float gain) noexcept
{
    targetGain.store(juce::jlimit(0.0F, 1.0F, gain), std::memory_order_release);
}

void ScratchAudioSource::seekUs(std::int64_t positionUs) noexcept
{
    const auto sourceSamples = audio != nullptr ? audio->getNumSamples() : 0;
    const auto requestedSample = static_cast<std::int64_t>(
        (static_cast<double>(juce::jmax<std::int64_t>(0, positionUs)) * sourceSampleRate)
        / 1000000.0);
    const auto clampedSample = clampSourceSampleIndex(sourceSamples, requestedSample);
    pendingSeekSourceSample.store(
        clampedSample,
        std::memory_order_release);
    publishedSourcePosition.store(
        static_cast<double>(clampedSample),
        std::memory_order_release);
    sourceEndReached.store(false, std::memory_order_release);
    seekGeneration.fetch_add(1, std::memory_order_acq_rel);
}

void ScratchAudioSource::beginPatternReplay(const PatternReplaySnapshot* snapshot) noexcept
{
    const bool wasActive = active.exchange(false, std::memory_order_acq_rel);
    replaySnapshot.store(nullptr, std::memory_order_release);
    waitForCallbackQuiescence();
    replayOutputSamples = 0;
    replayNormalized.store(0.0, std::memory_order_release);
    outputSampleCounter.store(0, std::memory_order_release);
    sourceEndReached.store(false, std::memory_order_release);

    if (snapshot == nullptr || snapshot->empty())
    {
        active.store(wasActive, std::memory_order_release);
        return;
    }

    const auto initialTurns = snapshot->platter.front().turns;
    const auto initialPosition = initialTurns * VinylScratchProcessor::kSecondsPerTurn
                                 * sourceSampleRate;
    const auto initial = ScratchPatternEvaluator::evaluate(
        *snapshot, juce::jmin<std::int64_t>(snapshot->durationUs() - 1, 1));
    processor.reset(
        initialPosition,
        initial.playbackRate * sourceSamplesPerOutputSample,
        static_cast<float>(initial.crossfaderGain));
    publishedSourcePosition.store(initialPosition, std::memory_order_release);
    replaySnapshot.store(snapshot, std::memory_order_release);
    active.store(wasActive, std::memory_order_release);
}

void ScratchAudioSource::endPatternReplay() noexcept
{
    const bool wasActive = active.exchange(false, std::memory_order_acq_rel);
    replaySnapshot.store(nullptr, std::memory_order_release);
    waitForCallbackQuiescence();
    replayOutputSamples = 0;
    replayNormalized.store(0.0, std::memory_order_release);
    active.store(wasActive, std::memory_order_release);
}

bool ScratchAudioSource::consumeEndReached() noexcept
{
    return sourceEndReached.exchange(false, std::memory_order_acq_rel);
}

bool ScratchAudioSource::isAtForwardBoundary() const noexcept
{
    const auto sourceSamples = audio != nullptr ? audio->getNumSamples() : 0;
    if (sourceSamples <= 0)
        return false;
    return publishedSourcePosition.load(std::memory_order_acquire)
           >= static_cast<double>(sourceSamples - 1);
}

ScratchAudioSource::Snapshot ScratchAudioSource::snapshot() const noexcept
{
    Snapshot result;
    const auto sourcePosition = publishedSourcePosition.load(std::memory_order_acquire);
    result.positionUs = static_cast<std::int64_t>(
        juce::jmax(0.0, sourcePosition) * 1000000.0 / sourceSampleRate);
    const auto sourceSamples = audio != nullptr ? audio->getNumSamples() : 0;
    result.durationUs = static_cast<std::int64_t>(
        static_cast<double>(sourceSamples) * 1000000.0 / sourceSampleRate);
    result.platterTurns = VinylScratchProcessor::turnsForSeconds(
        sourcePosition / sourceSampleRate);
    result.playbackRate = publishedSemanticRate.load(std::memory_order_acquire);
    result.playing = motorPlaying.load(std::memory_order_acquire);
    result.touched = platterTouched.load(std::memory_order_acquire);
    return result;
}

} // namespace silverdaw::scratch
