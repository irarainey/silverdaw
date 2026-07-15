#pragma once

#include "BusGraph.h"
#include "AudioConstants.h"
#include "EdgeFadeSnapshot.h"
#include "BrakeSnapshot.h"
#include "BackspinSnapshot.h"
#include "EnvelopeSnapshot.h"
#include "Log.h"
#include "OutputKeepAlive.h"
#include "TrackChain.h"
#include "WarpProcessor.h"
#include "MasterClockSource.h"
#include "MeteringSource.h"
#include "Metronome.h"
#include "OffsetSource.h"
#include "PreviewMetronomeSource.h"
#include "scratch/ScratchSessionController.h"
#include "scratch/ScratchAudioSource.h"
#include "scratch/BackingMonitorSource.h"
#include "scratch/ScratchProtocol.h"
#include "scratch/ScratchPatternEvaluator.h"

#include <algorithm>
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
#include <unordered_set>
#include <utility>
#include <vector>

namespace silverdaw
{

class ProjectState;

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

    // Fast, device-independent graph setup (formats, read-ahead, source wiring). Lets the
    // bridge start and accept project/graph commands before the (possibly slow) device open.
    void initialiseGraph();

    // Blocking device open + audio-callback/listener attach + snapshot. Split from
    // initialiseGraph so the caller can open the device after the bridge is already serving.
    juce::String openAudioDevice(const juce::String& preferredTypeName = {},
                                 const juce::String& preferredDeviceName = {},
                                 bool* outFellBackToDefault = nullptr);

    // True once the audio device is open and the engine is safe to play through. Reads are
    // valid from any thread (e.g. the bridge I/O thread and message-thread command handlers).
    bool isAudioReady() const noexcept { return audioReady.load(std::memory_order_acquire); }

    void shutdown();

    bool addClip(const juce::String& trackId, const juce::String& clipId,
                 const juce::File& filePath, double initialOffsetMs = 0.0,
                 double inMs = 0.0, double clipDurationMs = 0.0, float initialGain = 1.0F,
                 juce::String* outError = nullptr);

    // Overload that consumes a reader opened ahead of time (e.g. in parallel across many clips
    // during project load) so the serial attach path never pays per-clip file-open I/O. Ownership
    // of the reader transfers in. A null reader is treated as an open failure.
    bool addClip(const juce::String& trackId, const juce::String& clipId,
                 std::unique_ptr<juce::AudioFormatReader> reader, const juce::File& filePath,
                 double initialOffsetMs = 0.0, double inMs = 0.0, double clipDurationMs = 0.0,
                 float initialGain = 1.0F, juce::String* outError = nullptr);

    // Open an audio reader for a clip source (WAV/compressed), with the same MediaFoundation
    // stream fallback as addClip. Thread-safe against the shared format manager, so callers may
    // run this concurrently on a worker pool to overlap the (I/O-bound) opens. Returns null if the
    // file cannot be read.
    std::unique_ptr<juce::AudioFormatReader> createReaderForClip(const juce::File& filePath);

    bool removeClip(const juce::String& clipId);
    bool moveClipToTrack(const juce::String& clipId, const juce::String& trackId);
    bool setClipGain(const juce::String& clipId, float gain);

    /** Excludes inaudible tracks from clip, warp, pitch, DSP, send, and meter rendering. */
    void setTrackAudible(const juce::String& trackId, bool audible);
    void setTracksAudible(
        const std::vector<std::pair<juce::String, bool>>& audibility);

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

    // Drop every automation lane on `trackId`, snapping each automated parameter back to its
    // neutral default. Used when rebuilding the engine from project state so a lane removed by
    // undo/redo can't leave its last automated value stuck live in the chain. No-op when the
    // track has no automation.
    void clearAllTrackAutomation(const juce::String& trackId);

    void setProjectReverb(float size, float decay, float tone, float mix, bool snap);

    // Delay time is staged while playing; feedback, tone, and mix apply live.
    void setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap);

    void drainAllTrackPeaks(std::vector<BusGraph::TrackPeakSnapshot>& out);

    // Total audio blocks the bus graph dropped under message-thread contention.
    juce::uint64 busGraphSkippedBlocks() const noexcept { return busGraph.audioBlocksSkipped(); }

    /** Number of superseded render snapshots awaiting a safe reclamation point. */
    std::size_t retiredPlaybackSnapshotCount() const noexcept;

    // Drains audio-thread block-timing for non-RT perf logging.
    MasterClockSource::AudioPerfSnapshot drainAudioPerf() noexcept { return master.drainAudioPerf(); }

    void setPositionMs(double ms);
    bool scrubPositionMs(double positionMs, double deltaMs);

    bool setClipOffsetMs(const juce::String& clipId, double offsetMs);
    bool commitClipOffset(const juce::String& clipId);

    bool setClipTrim(const juce::String& clipId, double startMs, double inMs, double clipDurationMs);

    bool setClipWarp(const juce::String& clipId,
                     std::optional<bool> enabled,
                     std::optional<juce::String> mode,
                     std::optional<double> tempoRatio,
                     std::optional<double> semitones,
                     std::optional<double> cents);
    bool canWarpClip(const juce::String& clipId) const noexcept;

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
    bool setClipBackspin(const juce::String& clipId, double backspinSeconds,
                         double spinSpeed = BackspinSnapshot::kDefaultSpinSpeed,
                         double curvePower = BackspinSnapshot::kDefaultCurvePower);
    double getBackspinDefaultSeconds() const { return backspinDefaultSeconds; }
    double getBackspinDefaultSpeed() const { return backspinDefaultSpeed; }
    double getBackspinDefaultCurve() const { return backspinDefaultCurve; }
    void setBackspinDefaults(double seconds, double speed, double curve);

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

    // Release any open reader the engine holds on `file` (currently the preview voice)
    // so the file can be deleted cleanly — a lingering JUCE reader keeps a deleted WAV
    // in Windows delete-pending limbo, which blocks removing its per-source folder.
    void releaseReadersForFile(const juce::File& file);

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

    // Clip Editor metronome: clicks on the clip's own beat grid (source BPM + phase anchor) during
    // preview playback, independent of the main-timeline metronome.
    void setPreviewMetronomeEnabled(bool enabled);
    void setPreviewMetronomeGrid(double bpm, double beatAnchorSec);

    /** Apply a turntable brake to the clip-editor preview (record-stop at clip end). */
    bool setPreviewBrake(double brakeSeconds,
                         double curvePower = BrakeSnapshot::kDefaultCurvePower);
    bool setPreviewBackspin(double backspinSeconds,
                            double spinSpeed = BackspinSnapshot::kDefaultSpinSpeed,
                            double curvePower = BackspinSnapshot::kDefaultCurvePower);

    juce::int64 getPreviewGeneration() const;

    using ScratchSessionSnapshot = scratch::ScratchSessionController::Snapshot;

    juce::String beginScratchSession(const juce::String& clipId);
    bool completeScratchSession(
        const juce::String& sessionId,
        std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
        double preparedSampleRate);
    bool failScratchSession(const juce::String& sessionId, const juce::String& error);
    bool setScratchPreparationProgress(const juce::String& sessionId, double progress);
    bool closeScratchSession(const juce::String& sessionId);
    // Backing accompaniment monitor (ADR 0021, Amendment 1).
    bool beginScratchBackingPreparation(const juce::String& sessionId);
    bool completeScratchBacking(
        const juce::String& sessionId,
        std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
        double preparedSampleRate);
    bool failScratchBacking(const juce::String& sessionId, const juce::String& error);
    bool clearScratchBacking(const juce::String& sessionId);
    bool controlScratchSession(const scratch::SessionControlPayload& control);
    bool scratchMidiRecordToggle();
    bool scratchMidiSetTouch(const juce::String& deviceIdentifier,
                             scratch::DeckSide deck,
                             bool touched);
    bool scratchMidiMovePlatter(const juce::String& deviceIdentifier,
                                scratch::DeckSide deck,
                                double deltaTurns,
                                double timestampMs);
    bool scratchMidiSetCrossfader(const juce::String& deviceIdentifier,
                                  double directedValue, double displayValue = -1.0,
                                  bool reverseCrossfader = false);
    bool setScratchMidiCrossfaderDirection(const juce::String& deviceIdentifier,
                                           bool reverseCrossfader);
    bool hasActiveScratchSession() const;
    void setScratchMidiSelectedDeck(const juce::String& deviceIdentifier,
                                    scratch::DeckSide deck,
                                    bool reverseCrossfader);
    bool releaseScratchMidiOwner(const juce::String& deviceIdentifier,
                                 std::optional<scratch::DeckSide> deck = std::nullopt);
    std::optional<ScratchSessionSnapshot> getScratchSessionSnapshot() const;
    bool reconcileScratchSessionSourceEnd();

    // Retrieve completed recording pattern (moves ownership). Returns nullopt if none ready.
    std::optional<scratch::Pattern> takeScratchRecordingPattern();

    // Immutable prepared source audio for offline baking of a saved scratch.
    // Message-thread only; null when no source is prepared.
    std::shared_ptr<const juce::AudioBuffer<float>> getScratchPreparedSource() const;
    double getScratchPreparedSourceSampleRate() const;

    // Pattern replay audition (plays a saved pattern through the scratch audio source).
    bool startScratchPatternReplay(const scratch::Pattern& pattern);
    void stopScratchPatternReplay();
    bool isScratchPatternReplaying() const noexcept;

    // Clip-level pattern snapshot management for timeline playback.
    void rebuildClipPatternSnapshot(const juce::String& clipId, const ProjectState& projectState);
    void clearClipPatternSnapshot(const juce::String& clipId);
    void rebuildAllClipPatternSnapshots(const ProjectState& projectState);

    // Test-only: direct access to the scratch audio source for render verification.
    scratch::ScratchAudioSource& scratchSourceForTest() { return scratchSource; }

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
        int currentOutputChannels = 0;
        int currentBitDepth = 0;
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

    // Explicit per-device keep-awake toggle (default off). When enabled, the keep-alive tone +
    // one-time first-play wake keep a sleep-prone USB output from clipping the first beat. The
    // renderer resolves the open device's setting and pushes it. Message-thread only.
    void setKeepAwakeEnabled(bool enabled);

    using DeviceListChangedCallback = std::function<void()>;
    void setDeviceListChangedCallback(DeviceListChangedCallback cb)
    {
        deviceListChangedCallback = std::move(cb);
    }

  private:
    struct Track
    {
        juce::String trackId;
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::BufferingAudioSource> bufferingSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        std::unique_ptr<WarpProcessor> warp;
        // Current Rubber Band time-stretch mode for `warp`. Lets setClipWarp skip rebuilding the
        // stretcher (a heavy alloc + history reset) when only the ratio/pitch changed or the same
        // state is re-applied (e.g. replaying effects on an incremental undo). Empty when no warp.
        juce::String warpMode;
        std::vector<std::unique_ptr<WarpProcessor>> retiredWarps;
        std::unique_ptr<EnvelopeSnapshot> envelopeSnapshot;
        // Retire replaced snapshots/processors until the audio thread is quiescent.
        std::vector<std::unique_ptr<EnvelopeSnapshot>> retiredEnvelopes;
        std::unique_ptr<EdgeFadeSnapshot> edgeFadeSnapshot;
        std::vector<std::unique_ptr<EdgeFadeSnapshot>> retiredEdgeFades;
        std::unique_ptr<BrakeSnapshot> brakeSnapshot;
        std::vector<std::unique_ptr<BrakeSnapshot>> retiredBrakes;
        std::unique_ptr<BackspinSnapshot> backspinSnapshot;
        std::vector<std::unique_ptr<BackspinSnapshot>> retiredBackspins;
        // Immutable pattern replay snapshot published to OffsetSource for audio-thread reads.
        std::shared_ptr<const scratch::PatternReplaySnapshot> patternSnapshot;
        double sampleRate = 44100.0;
        int numChannels = 2;
        juce::int64 latencySamples = 0;

        bool prefetchDirty = false;
    };

    double trackSeekSecondsFor(const Track& track, juce::int64 masterSamples) const;

    void recreateTrackPrefetch(Track& track, double positionSeconds);

    void rebuildTrackPrefetch(Track& track);

    // Schedules the post-edit prefetch rebuild: immediately if playing (must drain stale
    // read-ahead at once), or marks dirty + starts the debounce timer if stopped.
    void scheduleTrackPrefetchAfterEdit(Track& track);

    void reclaimRetiredPlaybackSnapshots();

    // Rebuilds the preview transport's read-ahead buffer so a changed envelope/gain is heard from
    // the first played block. JUCE's BufferingAudioSource won't invalidate an already-cached region
    // in place, so re-setting the source is the only reliable flush when the transport is stopped.
    void rebuildPreviewReadAhead();

    // Push the preview's current in-point + warp ratio to the metronome wrapper so its clicks track
    // the clip's beat grid through any time-warp.
    void updatePreviewMetronomeMapping();

    void flushAllDirtyRebuildsSync();

    void flushDirtyRebuilds();

    void flushPendingTrackBypasses();
    void setTrackAudibleUntil(const juce::String& trackId, bool audible,
                              double prefetchDeadlineMs,
                              juce::AudioBuffer<float>& prefetchScratch);
    bool isTrackAudible(const juce::String& trackId) const noexcept;
    bool waitForTrackPrefetch(Track& track, double deadlineMs,
                              juce::AudioBuffer<float>& scratch);

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

    class TrackBypassTimer : public juce::Timer
    {
      public:
        explicit TrackBypassTimer(AudioEngine& e) : engine(e) {}
        void timerCallback() override { engine.flushPendingTrackBypasses(); }

      private:
        AudioEngine& engine;
    };
    TrackBypassTimer trackBypassTimer{*this};
    std::unordered_set<juce::String> pendingTrackBypasses;
    std::unordered_map<juce::String, bool> trackAudibility;
    static constexpr int kTrackBypassPollMs = 5;

    double brakeDefaultSeconds = BrakeSnapshot::kPlatterStopSeconds;
    double brakeDefaultCurve = BrakeSnapshot::kDefaultCurvePower;
    double backspinDefaultSeconds = BackspinSnapshot::kDefaultSpinSeconds;
    double backspinDefaultSpeed = BackspinSnapshot::kDefaultSpinSpeed;
    double backspinDefaultCurve = BackspinSnapshot::kDefaultCurvePower;

    bool pendingSeekPrewarm = false;

    juce::AudioDeviceManager deviceManager;
    juce::AudioSourcePlayer sourcePlayer;
    BusGraph busGraph;

    // Set true (on the message thread) once the device is open and finalised; read from any
    // thread. Signals audio readiness to the bridge (ENGINE_AUDIO_STATUS).
    std::atomic<bool> audioReady{false};

    // Per-track automation snapshots owned here (message thread). `current` holds
    // the live snapshot per track; `retired` holds superseded ones until a stop
    // reclaims them, so the audio thread never frees. See setTrackAutomation.
    std::unordered_map<juce::String, std::unique_ptr<TrackAutomationSnapshot>> automationCurrent;
    std::vector<std::unique_ptr<TrackAutomationSnapshot>> retiredAutomation;

    void rebuildDevicesSnapshot(bool rescan);

    // Opens the default OUTPUT endpoint only (no capture). The engine never records, and
    // opening the default input endpoint can stall for tens of seconds on a bad default
    // mic (e.g. a Bluetooth HFP headset) — the cold-start hang. Returns any JUCE error.
    juce::String openDefaultOutputOnly();

    // The blocking half of openAudioDevice(): opens the pinned/default output device and
    // logs the elapsed time. Safe to run off the message thread. Returns any JUCE error.
    juce::String openAudioDeviceBlocking(const juce::String& preferredTypeName,
                                         const juce::String& preferredDeviceName,
                                         bool& outFellBack);

    // The message-thread half of openAudioDevice(): attaches the audio callback + device
    // change listener, rebuilds the device snapshot, logs the inventory, and flips audioReady.
    void finaliseAudioDevice(bool fellBack);

    void onDeviceListChanged();

    AudioDevicesSnapshot devicesSnapshot;
    DeviceListChangedCallback deviceListChangedCallback;
    bool hasFullyScanned = false;

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
        std::unique_ptr<BackspinSnapshot> backspinSnapshot;
        std::vector<std::unique_ptr<BackspinSnapshot>> retiredBackspins;
        juce::String warpMode{"rhythmic"};
        double sampleRate = 44100.0;
        double inMs = 0.0;
        double durationMs = 0.0;
        double sourceDurationMs = 0.0;
        // Absolute path of the file currently loaded into the preview voice, so the
        // engine can release this reader before that file is deleted from disk (an
        // open JUCE reader keeps the WAV delete-pending on Windows, which would block
        // removing its now-empty per-source folder).
        juce::File sourceFile;
    };
    Preview preview;
    // Wraps the preview transport to mix the Clip Editor metronome click; added to topMixer in
    // place of the bare transport while a preview is loaded. Its enabled state persists across
    // reloads so toggling the click doesn't require a live preview.
    std::unique_ptr<PreviewMetronomeSource> previewMetronomeSource;
    bool previewMetronomeEnabled = false;
    double previewMetronomeBpm = 0.0;
    double previewMetronomeAnchorSec = 0.0;
    std::atomic<juce::int64> previewGeneration{0};

    // Persistent scratch audio source — always wired into topMixer (fixed topology).
    // Session open/close activates/deactivates via atomics; no callback allocation.
    scratch::ScratchAudioSource scratchSource;
    // Backing accompaniment bed (ADR 0021, Amendment 1) — also fixed topology in
    // topMixer; activated only when a backing window is prepared.
    scratch::BackingMonitorSource backingSource;
    scratch::ScratchSessionController scratchController{scratchSource, backingSource};

    // Pattern replay state (audition of a saved pattern through the scratch source).
    std::shared_ptr<const scratch::PatternReplaySnapshot> patternReplaySnapshot;
    std::atomic<bool> patternReplayActive{false};
    std::atomic<std::int64_t> patternReplayPositionUs{0};
};

} // namespace silverdaw
