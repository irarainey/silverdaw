#include "InputCaptureTap.h"

namespace silverdaw::recording
{

void InputCaptureTap::setChannelSelection(int firstChannel, int channelCount) noexcept
{
    const auto first = juce::jmax(0, firstChannel);
    const auto count = juce::jlimit(1, 2, channelCount);
    channelSelection.store((first << 8) | count, std::memory_order_relaxed);
}

void InputCaptureTap::setWriter(juce::AudioFormatWriter::ThreadedWriter* writer) noexcept
{
    activeWriter.store(writer, std::memory_order_release);
}

void InputCaptureTap::waitForQuiescence(int timeoutMs) noexcept
{
    const auto start = callbackTicks.load(std::memory_order_acquire);
    const auto deadline = juce::Time::getMillisecondCounter() + static_cast<juce::uint32>(timeoutMs);
    while (callbackTicks.load(std::memory_order_acquire) - start < 2)
    {
        if (juce::Time::getMillisecondCounter() >= deadline) return;
        juce::Thread::sleep(1);
    }
}

void InputCaptureTap::resetCaptureStats() noexcept
{
    capturedSamples.store(0);
    droppedSamples.store(0);
    firstBlockTicks.store(0);
    lastBlockTicks.store(0);
    hitLengthCap.store(false);
    sawSignal.store(false);
}

void InputCaptureTap::consumePeaks(float& outL, float& outR) noexcept
{
    outL = peakL.exchange(0.0F, std::memory_order_relaxed);
    outR = peakR.exchange(0.0F, std::memory_order_relaxed);
}

void InputCaptureTap::atomicMaxFloat(std::atomic<float>& target, float value) noexcept
{
    float current = target.load(std::memory_order_relaxed);
    while (value > current
           && ! target.compare_exchange_weak(current, value, std::memory_order_relaxed))
    {
    }
}

void InputCaptureTap::audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                                       int numInputChannels,
                                                       float* const* outputChannelData,
                                                       int numOutputChannels, int numSamples,
                                                       const juce::AudioIODeviceCallbackContext&)
{
    // An input-only device should present no outputs; clear defensively.
    for (int channel = 0; channel < numOutputChannels; ++channel)
        if (outputChannelData[channel] != nullptr)
            juce::FloatVectorOperations::clear(outputChannelData[channel], numSamples);

    const auto packed = channelSelection.load(std::memory_order_relaxed);
    const int first = juce::jlimit(0, juce::jmax(0, numInputChannels - 1), packed >> 8);
    const int count = juce::jlimit(1, juce::jmax(1, numInputChannels - first), packed & 0xFF);

    if (numSamples <= 0 || numInputChannels <= 0 || inputChannelData == nullptr)
    {
        callbackTicks.fetch_add(1, std::memory_order_release);
        return;
    }

    const float* const* selected = inputChannelData + first;

    // Apply the input gain into scratch space so both the meter and the file see
    // the same signal. Falls back to unity if a block ever arrives larger than the
    // buffer the device promised — allocating here is not an option.
    const float linearGain = gain.load(std::memory_order_relaxed);
    if (linearGain != 1.0F && numSamples <= gainBuffer.getNumSamples())
    {
        for (int channel = 0; channel < count && channel < 2; ++channel)
        {
            auto* destination = gainBuffer.getWritePointer(channel);
            const auto* source = selected[channel];
            if (source != nullptr)
                juce::FloatVectorOperations::copyWithMultiply(destination, source, linearGain,
                                                              numSamples);
            else
                juce::FloatVectorOperations::clear(destination, numSamples);
            gainChannels[channel] = destination;
        }
        selected = gainChannels;
    }

    float left = 0.0F;
    float right = 0.0F;
    for (int channel = 0; channel < count; ++channel)
    {
        const auto* data = selected[channel];
        if (data == nullptr) continue;
        const auto range = juce::FloatVectorOperations::findMinAndMax(data, numSamples);
        const auto magnitude = juce::jmax(std::abs(range.getStart()), std::abs(range.getEnd()));
        if (channel == 0) left = magnitude;
        right = magnitude;
    }
    atomicMaxFloat(peakL, left);
    atomicMaxFloat(peakR, count > 1 ? right : left);
    if (left > 0.0F || right > 0.0F) sawSignal.store(true, std::memory_order_relaxed);

    if (auto* writer = activeWriter.load(std::memory_order_acquire))
    {
        const auto cap = maxSamples.load(std::memory_order_relaxed);
        const auto captured = capturedSamples.load(std::memory_order_relaxed);
        if (cap > 0 && captured >= cap)
        {
            hitLengthCap.store(true, std::memory_order_relaxed);
        }
        else
        {
            const auto now = juce::Time::getHighResolutionTicks();
            juce::int64 expected = 0;
            firstBlockTicks.compare_exchange_strong(expected, now, std::memory_order_relaxed);
            lastBlockTicks.store(now, std::memory_order_relaxed);

            const int toWrite = cap > 0
                                    ? static_cast<int>(juce::jmin(static_cast<juce::int64>(numSamples),
                                                                  cap - captured))
                                    : numSamples;
            if (writer->write(selected, toWrite))
                capturedSamples.store(captured + toWrite, std::memory_order_relaxed);
            else
                droppedSamples.fetch_add(toWrite, std::memory_order_relaxed);
        }
    }

    callbackTicks.fetch_add(1, std::memory_order_release);
}

void InputCaptureTap::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    deviceStopped.store(false, std::memory_order_relaxed);
    // Sized here, on the device thread before streaming starts, so the callback
    // itself never allocates. Headroom for a device that hands over a longer block
    // than it advertises.
    const int blockSize = device != nullptr ? juce::jmax(512, device->getCurrentBufferSizeSamples() * 2)
                                            : 4096;
    gainBuffer.setSize(2, blockSize, false, true, false);
    gainChannels[0] = nullptr;
    gainChannels[1] = nullptr;
}

void InputCaptureTap::audioDeviceStopped()
{
    deviceStopped.store(true, std::memory_order_relaxed);
}

void InputCaptureTap::audioDeviceError(const juce::String& message)
{
    deviceError = message;
}

} // namespace silverdaw::recording
