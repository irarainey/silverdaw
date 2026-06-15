#pragma once

#include <atomic>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <juce_core/juce_core.h>

#include "EdgeFadeSnapshot.h"

namespace silverdaw
{

class BridgeServer;
class ProjectState;

// Worker renders read an immutable message-thread snapshot, never the live ValueTree.
struct MixdownSnapshot
{
    struct ClipSnapshot
    {
        juce::String id;
        juce::String libraryItemId;
        juce::String filePath;
        double offsetMs{0.0};
        double inMs{0.0};
        double durationMs{0.0};
        double effectiveDurationMs{0.0};
        juce::Array<juce::var> envelopePoints;
        bool edgeFadeIn{false};
        double edgeFadeInStartMs{0.0};
        double edgeFadeInEndMs{0.0};
        EdgeFadeCurve edgeFadeInCurve{EdgeFadeCurve::equalPower};
        bool edgeFadeOut{false};
        double edgeFadeOutStartMs{0.0};
        double edgeFadeOutEndMs{0.0};
        EdgeFadeCurve edgeFadeOutCurve{EdgeFadeCurve::equalPower};
        bool warpEnabled{false};
        juce::String warpMode; // "rhythmic" / "tonal" / "complex"
        double tempoRatio{1.0};
        double semitones{0.0};
        double cents{0.0};
        int sourceSampleRate{0};
        int sourceChannelCount{0};
    };

    struct TrackSnapshot
    {
        juce::String id;
        float gain{1.0F};
        // Snapshot live per-track parameters so offline render stays in parity with playback.
        float toneBassDb{0.0F};
        float toneMidDb{0.0F};
        float toneTrebleDb{0.0F};
        float toneFilter{0.0F};
        float levelerAmount{0.0F};
        float reverbSend{0.0F};
        float delaySend{0.0F};
        float pan{0.0F};
        std::vector<ClipSnapshot> clips;
    };

    int projectSampleRate{44100};
    // Loudness normalization uses a measured pass before final gain, limiting, dither, and
    // encode.
    float masterGain{1.0F};
    // Offline render uses the same SharedFx settings as playback for export parity.
    float reverbSize{0.0F};
    float reverbDecay{0.0F};
    float reverbTone{0.0F};
    float reverbMix{0.0F};
    juce::String delayNoteValue{"1/8"};
    float delayFeedback{0.0F};
    float delayTone{0.0F};
    float delayMix{0.0F};
    double bpm{120.0};
    std::vector<TrackSnapshot> tracks;
};

// JUCE 8 lacks some tag hooks, so FLAC/AIFF metadata is post-processed after encode.
struct ExportMetadata
{
    juce::String title;
    juce::String artist;
    juce::String album;
    juce::String year;
    juce::String genre;
    juce::String comment;

    bool isEmpty() const noexcept
    {
        return title.isEmpty() && artist.isEmpty() && album.isEmpty()
            && year.isEmpty()  && genre.isEmpty()  && comment.isEmpty();
    }
};

struct MixdownOptions
{
    enum class Format { Wav, Mp3, Flac, Aiff };

    juce::File outputFile;
    int outputSampleRate{44100};
    Format format{Format::Wav};
    int bitDepth{16};
    // Shared TPDF dither keeps 16-bit output identical across render paths.
    bool dither{true};
    double tailSeconds{0.0};
    enum class LoudnessMode { Off, AnalyzeOnly, Normalize };
    LoudnessMode loudnessMode{LoudnessMode::Off};
    double targetLufs{-14.0};
    double ceilingDbtp{-1.0};
    int bitrateKbps{192};
    double lengthMs{0.0};
    // Project-time offset to begin rendering from; earlier audio is rendered then
    // discarded so clip positions and FX tails stay correct. 0 = project origin.
    double startMs{0.0};
    ExportMetadata metadata;
};

enum class MixdownFailureCode
{
    Cancelled,
    Io,
    Decode,
    Encode,
    Invalid
};

const char* mixdownFailureCodeToString(MixdownFailureCode code) noexcept;

MixdownSnapshot snapshotProjectForMixdown(const ProjectState& project);

double computeLastClipEndMs(const MixdownSnapshot& snapshot);

// Cancellation is checked at block boundaries and before encoder writes.
void renderMixdownAsync(MixdownSnapshot snapshot,
                        MixdownOptions options,
                        juce::ThreadPool& pool,
                        BridgeServer& bridge,
                        std::atomic<bool>& cancelFlag,
                        std::atomic<bool>& busyFlag);

} // namespace silverdaw
