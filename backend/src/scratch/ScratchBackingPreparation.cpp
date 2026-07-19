#include "ScratchBackingPreparation.h"

#include "MixdownGraph.h"
#include "SafetyLimiter.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>

namespace silverdaw::scratch
{
using mixdown_graph::buildOfflineClip;
using mixdown_graph::kBlockFrames;
using mixdown_graph::kOutputChannels;
using mixdown_graph::OfflineClip;

bool prepareBackingToBuffer(const MixdownSnapshot& snapshot,
                            double anchorMs,
                            double durationMs,
                            PreparedBacking& result,
                            juce::String& error,
                            const std::function<bool()>& shouldCancel)
{
    const int projectSampleRate = juce::jmax(1, snapshot.projectSampleRate);
    const double framesPerMs = static_cast<double>(projectSampleRate) / 1000.0;
    const auto startFrames = static_cast<juce::int64>(
        std::llround(juce::jmax(0.0, anchorMs) * framesPerMs));
    const auto windowFrames = static_cast<juce::int64>(
        std::llround(juce::jmax(0.0, durationMs) * framesPerMs));
    if (windowFrames <= 0)
    {
        error = "Backing window duration is zero";
        return false;
    }
    const auto endFrames = startFrames + windowFrames;

    const auto isCancelled = [&shouldCancel] { return shouldCancel && shouldCancel(); };

    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();

    std::vector<std::unique_ptr<OfflineClip>> clips;
    for (const auto& track : snapshot.tracks)
    {
        for (const auto& clip : track.clips)
        {
            if (isCancelled())
            {
                error = "Cancelled";
                return false;
            }
            juce::String clipError;
            auto built = buildOfflineClip(clip, track.id, track.gain, projectSampleRate,
                                          formatManager, clipError);
            if (built == nullptr)
            {
                error = "Could not open source for clip " + clip.id
                      + (clipError.isNotEmpty() ? juce::String(": ") + clipError
                                                : juce::String());
                return false;
            }
            clips.push_back(std::move(built));
        }
    }

    auto dest = std::make_shared<juce::AudioBuffer<float>>(
        kOutputChannels, static_cast<int>(windowFrames));
    dest->clear();

    juce::AudioBuffer<float> mixBus(kOutputChannels, kBlockFrames);
    juce::AudioBuffer<float> clipBuffer(kOutputChannels, kBlockFrames);
    silverdaw::SafetyLimiter safetyLimiter;
    safetyLimiter.prepare(static_cast<double>(projectSampleRate));
    safetyLimiter.setEnabled(snapshot.safetyLimiterEnabled, /*snap*/ true);

    juce::int64 renderedFrames = 0;
    while (renderedFrames < endFrames)
    {
        if (isCancelled())
        {
            error = "Cancelled";
            return false;
        }
        const juce::ScopedNoDenormals scopedNoDenormals;
        const int blockFrames = static_cast<int>(
            std::min<juce::int64>(kBlockFrames, endFrames - renderedFrames));

        mixBus.clear(0, blockFrames);
        for (auto& clip : clips)
        {
            if (clip->retired)
                continue;
            if (renderedFrames >= clip->timelineEndFrames + clip->tailFrames)
            {
                clip->retired = true;
                continue;
            }
            clipBuffer.clear(0, blockFrames);
            juce::AudioSourceChannelInfo clipInfo(&clipBuffer, 0, blockFrames);
            clip->summingSource->getNextAudioBlock(clipInfo);
            for (int ch = 0; ch < kOutputChannels; ++ch)
                mixBus.addFrom(ch, 0, clipBuffer, ch, 0, blockFrames);
        }

        if (!juce::approximatelyEqual(snapshot.masterGain, 1.0F))
            mixBus.applyGain(0, blockFrames, snapshot.masterGain);
        safetyLimiter.process(mixBus, 0, blockFrames);

        // Retain only frames within the requested window.
        const juce::int64 blockStart = renderedFrames;
        const juce::int64 keepStart = juce::jmax(startFrames, blockStart);
        const juce::int64 keepEnd = juce::jmin(endFrames, blockStart + blockFrames);
        if (keepEnd > keepStart)
        {
            const int srcOffset = static_cast<int>(keepStart - blockStart);
            const int destOffset = static_cast<int>(keepStart - startFrames);
            const int copyFrames = static_cast<int>(keepEnd - keepStart);
            for (int ch = 0; ch < kOutputChannels; ++ch)
                dest->copyFrom(ch, destOffset, mixBus, ch, srcOffset, copyFrames);
        }

        renderedFrames += blockFrames;
    }

    result.audio = std::move(dest);
    result.sampleRate = static_cast<double>(projectSampleRate);
    return true;
}

} // namespace silverdaw::scratch
