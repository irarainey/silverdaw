#pragma once

#include "BackspinSnapshot.h"
#include "BrakeSnapshot.h"
#include "EdgeFadeSnapshot.h"
#include "EnvelopeSnapshot.h"
#include "OffsetSource.h"
#include "PreviewMetronomeSource.h"
#include "WarpProcessor.h"
#include "scratch/ScratchPatternEvaluator.h"

#include <atomic>
#include <memory>
#include <unordered_map>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

// Timeline-clip and preview source ownership, including read-ahead state.
class AudioEnginePlaybackState
{
protected:
    struct Track
    {
        juce::String trackId;
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::BufferingAudioSource> bufferingSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        std::unique_ptr<WarpProcessor> warp;
        juce::String warpMode;
        std::vector<std::unique_ptr<WarpProcessor>> retiredWarps;
        std::unique_ptr<EnvelopeSnapshot> envelopeSnapshot;
        std::vector<std::unique_ptr<EnvelopeSnapshot>> retiredEnvelopes;
        std::unique_ptr<EdgeFadeSnapshot> edgeFadeSnapshot;
        std::vector<std::unique_ptr<EdgeFadeSnapshot>> retiredEdgeFades;
        std::unique_ptr<BrakeSnapshot> brakeSnapshot;
        std::vector<std::unique_ptr<BrakeSnapshot>> retiredBrakes;
        std::unique_ptr<BackspinSnapshot> backspinSnapshot;
        std::vector<std::unique_ptr<BackspinSnapshot>> retiredBackspins;
        std::shared_ptr<const scratch::PatternReplaySnapshot> patternSnapshot;
        double sampleRate = 44100.0;
        int numChannels = 2;
        juce::int64 latencySamples = 0;
        bool prefetchDirty = false;
    };

    struct Preview
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        std::unique_ptr<WarpProcessor> warp;
        std::vector<std::unique_ptr<WarpProcessor>> retiredWarps;
        std::unique_ptr<EnvelopeSnapshot> envelopeSnapshot;
        std::vector<std::unique_ptr<EnvelopeSnapshot>> retiredEnvelopes;
        std::unique_ptr<BrakeSnapshot> brakeSnapshot;
        std::vector<std::unique_ptr<BrakeSnapshot>> retiredBrakes;
        std::unique_ptr<BackspinSnapshot> backspinSnapshot;
        std::vector<std::unique_ptr<BackspinSnapshot>> retiredBackspins;
        juce::String warpMode{"rhythmic"};
        double sampleRate = 44100.0;
        double inMs = 0.0;
        double durationMs = 0.0;
        double sourceDurationMs = 0.0;
        juce::File sourceFile;
    };

    juce::TimeSliceThread readAheadThread{"silverdaw-readahead"};
    std::unordered_map<juce::String, std::unique_ptr<Track>> tracks;
    Preview preview;
    std::unique_ptr<PreviewMetronomeSource> previewMetronomeSource;
    bool previewMetronomeEnabled = false;
    double previewMetronomeBpm = 0.0;
    double previewMetronomeAnchorSec = 0.0;
    std::atomic<juce::int64> previewGeneration{0};
};

} // namespace silverdaw
