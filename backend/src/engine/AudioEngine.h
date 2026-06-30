#pragma once

#include "BusGraph.h"
#include "AudioConstants.h"
#include "EdgeFadeSnapshot.h"
#include "BrakeSnapshot.h"
#include "EnvelopeSnapshot.h"
#include "Log.h"
#include "OutputKeepAlive.h"
#include "OutputDeviceClassifier.h"
#include "TrackChain.h"
#include "WarpProcessor.h"
#include "MasterClockSource.h"
#include "MeteringSource.h"
#include "Metronome.h"
#include "OffsetSource.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <limits>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <memory>
#include <optional>
#include <unordered_map>

namespace silverdaw
{

class AudioEngine
{
  public:
    AudioEngine();
    ~AudioEngine();

    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    juce::String initialise(const juce::String& preferredTypeName = {},
                            const juce::String& preferredDeviceName = {},
                            bool* outFellBackToDefault = nullptr);

    void shutdown();

    bool addClip(const juce::String& trackId, const juce::String& clipId,
                 const juce::File& filePath, double initialOffsetMs = 0.0,
                 double inMs = 0.0, double clipDurationMs = 0.0, float initialGain = 1.0F,
                 juce::String* outError = nullptr);

    bool removeClip(const juce::String& clipId);

    bool setClipGain(const juce::String& clipId, float gain);

    void play();

    // Deep read-ahead priming avoids JUCE BufferingAudioSource dropping cold samples at play
    // start.
    bool primeTracksForPlayback(int totalBudgetMs);

    void pause();

    void stop();

    void setMasterGain(float gain);

    // Metronome monitoring click (post master gain). Enable/disable and keep the click in time with
    // the project tempo. Both publish to the audio thread via atomics.
    void setMetronomeEnabled(bool enabled);
    void setMetronomeBpm(double bpm);

    void consumeMasterPeaks(float& outL, float& outR);

    bool consumeTrackPeaks(const juce::String& trackId, float& outL, float& outR);

    void setTrackTone(const juce::String& trackId,
                      float bassDb, float midDb, float trebleDb, float filter,
                      bool snap);

    void setTrackLeveler(const juce::String& trackId, float amount, bool snap);

    void setTrackSends(const juce::String& trackId, float reverbSend, float delaySend);

    void setTrackPan(const juce::String& trackId, float pan);

    // Per-track effect automation: builds an immutable snapshot for `trackId`
    // (merging this param's curve with the track's other lanes), publishes it to
    // the BusGraph lock-free, and retires the previous snapshot. `points` is the
    // normalised `{ timeMs, value }` array; fewer than two points clears the lane.
    void setTrackAutomation(const juce::String& trackId, const juce::String& paramId,
                            const juce::Array<juce::var>& points);

    void setProjectReverb(float size, float decay, float tone, float mix, bool snap);

    // Delay time is staged while playing; feedback, tone, and mix apply live.
    void setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap);

    void drainAllTrackPeaks(std::vector<BusGraph::TrackPeakSnapshot>& out);

    // Total audio blocks the bus graph dropped under message-thread contention.
    juce::uint64 busGraphSkippedBlocks() const noexcept { return busGraph.audioBlocksSkipped(); }

    // Drains audio-thread block-timing for non-RT perf logging.
    MasterClockSource::AudioPerfSnapshot drainAudioPerf() noexcept { return master.drainAudioPerf(); }

    void setPositionMs(double ms);

    bool setClipOffsetMs(const juce::String& clipId, double offsetMs);
    bool commitClipOffset(const juce::String& clipId);

    bool setClipTrim(const juce::String& clipId, double startMs, double inMs, double clipDurationMs);

    bool setClipWarp(const juce::String& clipId,
                     std::optional<bool> enabled,
                     std::optional<juce::String> mode,
                     std::optional<double> tempoRatio,
                     std::optional<double> semitones,
                     std::optional<double> cents);

    bool setClipEnvelope(const juce::String& clipId, const juce::Array<juce::var>& points);

    /** Play a clip's window backwards (non-destructive); applied upstream of warp/pitch. */
    bool setClipReversed(const juce::String& clipId, bool reversed);

    bool setClipEdgeFade(const juce::String& clipId,
                         bool hasFadeIn, double fadeInStartMs, double fadeInEndMs,
                         bool hasFadeOut, double fadeOutStartMs, double fadeOutEndMs,
                         EdgeFadeCurve fadeInCurve = EdgeFadeCurve::equalPower,
                         EdgeFadeCurve fadeOutCurve = EdgeFadeCurve::equalPower);

    /** Apply a turntable brake (record-stop) over the last `brakeSeconds` of the clip.
     *  `brakeSeconds <= 0` clears it. Non-destructive; applied upstream of the read-ahead
     *  buffer like reverse/edge fades. v1 affects forward, non-warped clips only. */
    bool setClipBrake(const juce::String& clipId, double brakeSeconds,
                      double curvePower = BrakeSnapshot::kDefaultCurvePower);
    double getBrakeDefaultSeconds() const { return brakeDefaultSeconds; }
    double getBrakeDefaultCurve() const { return brakeDefaultCurve; }
    void setBrakeDefaults(double seconds, double curve);

    bool isPlaying() const;

    bool isContentLoaded() const;

    double getPositionMs() const;

    double getClipDurationMs(const juce::String& clipId) const;


    bool loadPreview(const juce::File& filePath, double inMs, double durationMs,
                     juce::String* outError = nullptr,
                     std::optional<bool> initialWarpEnabled = std::nullopt,
                     std::optional<juce::String> initialWarpMode = std::nullopt,
                     std::optional<double> initialTempoRatio = std::nullopt,
                     std::optional<double> initialSemitones = std::nullopt,
                     std::optional<double> initialCents = std::nullopt);

    void unloadPreview();

    void playPreview();

    void pausePreview();

    void stopPreview();

    void setPreviewPositionMs(double ms);

    double getPreviewPositionMs() const;

    double getPreviewDurationMs() const;

    bool isPreviewPlaying() const;

    /** True once the preview transport has played to the end of its source and
     *  auto-stopped (JUCE's stream-finished signal). A full-file sample preview
     *  reaches true EOF at exactly `durationMs`, so `isPreviewPlaying()` flips
     *  false before the position-based end check can observe it; this exposes the
     *  canonical EOF flag so the emitter can still raise `PREVIEW_ENDED`. */
    bool isPreviewFinished() const;

    bool isPreviewLoaded() const;

    bool setPreviewWarp(std::optional<bool> enabled,
                        std::optional<juce::String> mode,
                        std::optional<double> tempoRatio,
                        std::optional<double> semitones,
                        std::optional<double> cents);

    bool setPreviewEnvelope(const juce::Array<juce::var>& points);

    bool setPreviewReversed(bool reversed);

    /** Apply a turntable brake to the clip-editor preview (record-stop at clip end). */
    bool setPreviewBrake(double brakeSeconds,
                         double curvePower = BrakeSnapshot::kDefaultCurvePower);

    juce::int64 getPreviewGeneration() const;

    // Windows under-reports Bluetooth endpoint latency, so known headset names get a
    // conservative visual offset.
    double getOutputLatencyMs() const;

    double getHeuristicExtraLatencyMs() const;

    juce::AudioFormatManager& getFormatManager() noexcept
    {
        return formatManager;
    }

    // Avoid full device scans on startup; ASIO probing can block for hundreds of ms.
    struct DeviceTypeListing
    {
        juce::String typeName;
        juce::StringArray deviceNames;
    };

    struct AudioDevicesSnapshot
    {
        juce::Array<DeviceTypeListing> types;
        juce::String currentTypeName;
        juce::String currentDeviceName;
        double currentSampleRate = 0.0;
        int currentBufferSize = 0;
        double outputLatencyMs = 0.0;
        double heuristicExtraLatencyMs = 0.0;
        bool fellBackToDefault = false;
    };

    AudioDevicesSnapshot getAudioDevicesSnapshot() const
    {
        return devicesSnapshot;
    }

    void clearFellBackToDefault() noexcept
    {
        devicesSnapshot.fellBackToDefault = false;
    }

    void refreshAudioDevices();

    bool hasScannedAllDevices() const noexcept
    {
        return hasFullyScanned;
    }

    juce::String selectOutputDevice(const juce::String& typeName, const juce::String& deviceName);

    // User override for the keep-awake policy (auto / force-on / force-off). Applied immediately to
    // the current endpoint. Message-thread only.
    void setKeepAwakeMode(KeepAwakeMode mode);

    using DeviceListChangedCallback = std::function<void()>;
    void setDeviceListChangedCallback(DeviceListChangedCallback cb)
    {
        deviceListChangedCallback = std::move(cb);
    }

  private:
    struct Track
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::BufferingAudioSource> bufferingSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        std::unique_ptr<WarpProcessor> warp;
        std::vector<std::unique_ptr<WarpProcessor>> retiredWarps;
        std::unique_ptr<EnvelopeSnapshot> envelopeSnapshot;
        // Retire replaced snapshots/processors until the audio thread is quiescent.
        std::vector<std::unique_ptr<EnvelopeSnapshot>> retiredEnvelopes;
        std::unique_ptr<EdgeFadeSnapshot> edgeFadeSnapshot;
        std::vector<std::unique_ptr<EdgeFadeSnapshot>> retiredEdgeFades;
        std::unique_ptr<BrakeSnapshot> brakeSnapshot;
        std::vector<std::unique_ptr<BrakeSnapshot>> retiredBrakes;
        double sampleRate = 44100.0;
        int numChannels = 2;
        juce::int64 latencySamples = 0;

        bool prefetchDirty = false;
    };

    double trackSeekSecondsFor(const Track& track, juce::int64 masterSamples) const;

    void rebuildTrackPrefetch(Track& track);

    // Rebuilds the preview transport's read-ahead buffer so a changed envelope/gain is heard from
    // the first played block. JUCE's BufferingAudioSource won't invalidate an already-cached region
    // in place, so re-setting the source is the only reliable flush when the transport is stopped.
    void rebuildPreviewReadAhead();

    void flushAllDirtyRebuildsSync();

    void flushDirtyRebuilds();

    class RebuildTimer : public juce::Timer
    {
      public:
        explicit RebuildTimer(AudioEngine& e) : engine(e) {}
        void timerCallback() override
        {
            stopTimer();
            engine.flushDirtyRebuilds();
        }

      private:
        AudioEngine& engine;
    };
    RebuildTimer rebuildTimer{*this};
    static constexpr int kRebuildDebounceMs = 150;

    double brakeDefaultSeconds = BrakeSnapshot::kPlatterStopSeconds;
    double brakeDefaultCurve = BrakeSnapshot::kDefaultCurvePower;

    bool pendingSeekPrewarm = false;

    juce::AudioDeviceManager deviceManager;
    juce::AudioSourcePlayer sourcePlayer;
    BusGraph busGraph;

    // Per-track automation snapshots owned here (message thread). `current` holds
    // the live snapshot per track; `retired` holds superseded ones until a stop
    // reclaims them, so the audio thread never frees. See setTrackAutomation.
    std::unordered_map<juce::String, std::unique_ptr<TrackAutomationSnapshot>> automationCurrent;
    std::vector<std::unique_ptr<TrackAutomationSnapshot>> retiredAutomation;

    void rebuildDevicesSnapshot(bool rescan);

    // Classify the current output endpoint and enable/disable the keep-awake tone + one-time
    // first-play wake accordingly (sleep-prone USB endpoints only), subject to the user override
    // in `keepAwakeMode`. Message-thread only.
    void updateKeepAwakePolicy();

    void onDeviceListChanged();

    AudioDevicesSnapshot devicesSnapshot;
    DeviceListChangedCallback deviceListChangedCallback;
    bool hasFullyScanned = false;

    // User keep-awake override; autoDetect follows the bus classification. Message-thread only.
    KeepAwakeMode keepAwakeMode = KeepAwakeMode::autoDetect;

    class DeviceChangeListener : public juce::ChangeListener
    {
      public:
        explicit DeviceChangeListener(AudioEngine& e) : engine(e) {}
        void changeListenerCallback(juce::ChangeBroadcaster*) override
        {
            engine.onDeviceListChanged();
        }

      private:
        AudioEngine& engine;
    };
    DeviceChangeListener deviceChangeListener{*this};

    OutputKeepAlive outputKeepAlive;
    MasterClockSource master{busGraph, outputKeepAlive};
    juce::MixerAudioSource topMixer;
    Metronome metronome;
    MeteringSource masterMeter{topMixer, outputKeepAlive, master, metronome};
    juce::AudioFormatManager formatManager;

    juce::TimeSliceThread readAheadThread{"silverdaw-readahead"};

    std::unordered_map<juce::String, std::unique_ptr<Track>> tracks; // keyed by clipId


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
        juce::String warpMode{"rhythmic"};
        double sampleRate = 44100.0;
        double inMs = 0.0;
        double durationMs = 0.0;
        double sourceDurationMs = 0.0;
    };
    Preview preview;
    std::atomic<juce::int64> previewGeneration{0};
};

} // namespace silverdaw
