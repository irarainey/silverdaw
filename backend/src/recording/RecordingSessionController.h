#pragma once

#include "CaptureDevice.h"
#include "InputCaptureTap.h"
#include "RecordingWriter.h"

#include <juce_events/juce_events.h>

#include <functional>
#include <memory>
#include <optional>

namespace silverdaw
{
class AudioEngine;
class ProjectState;
}

namespace silverdaw::recording
{

/** Hard cap on one recording, mirroring MAX_RECORDING_SECONDS in the bridge
 *  schema. A forgotten session must not be able to fill a disk. */
constexpr double kMaxRecordingSeconds = 30.0 * 60.0;

/** Count-in is one bar or none: two bars was a choice nobody needed to make. */
constexpr int kMaxCountInBars = 1;

/** Input gain range, mirroring the dialog's slider. Never zero — a muted input is
 *  indistinguishable from a device that is delivering nothing. */
constexpr double kMinInputGainDb = -24.0;
constexpr double kMaxInputGainDb = 24.0;

/**
 * Where a recording anchor has to sit for its count-in to fit.
 *
 * A count-in is a preroll through the arrangement, so it needs `countInMs` of
 * arrangement in front of the anchor. Near the project start there is none, and
 * shortening the preroll instead throws the count-in away and records from the
 * top. The anchor moves to the first bar line that leaves room — the user asked
 * to be counted in, not to start immediately. A recording bounded by a range
 * keeps its anchor: the window is the user's explicit choice, and its length is
 * what makes the beat count it claims true (ADR 0024).
 */
constexpr double resolveCountInAnchorMs(double anchorMs, double countInMs, bool hasWindowEnd)
{
    if (countInMs <= 0.0 || hasWindowEnd || anchorMs >= countInMs) return anchorMs;
    return countInMs;
}

/**
 * What the engine's click should be doing for a recording session in `status`,
 * given the session's own **Click While Recording** setting.
 *
 * A session only ever *borrows* the click, and it borrows it in both directions:
 * a count-in forces it on for the preroll, and review forces it off — the click
 * is a recording aid, so a take played back against the arrangement must be
 * heard as it was captured and not over a click that sounds like part of it.
 * Everywhere else the session's own setting stands, including through the take
 * itself. That setting is seeded from the project's metronome and never written
 * back to it: opening the dialog and clicking through a take is not a reason for
 * the timeline's metronome to come back on afterwards.
 */
inline bool sessionMetronomeEnabled(const juce::String& status, bool clickEnabled)
{
    if (status == "countIn") return true;
    if (status == "review") return false;
    return clickEnabled;
}

struct RecordingInputInfo
{
    juce::String typeName;
    juce::String deviceName;
    juce::StringArray channelNames;
    double sampleRate = 0.0;
    double inputLatencyMs = 0.0;
};

/** Everything RECORD_SESSION_STATE carries, in backend terms. */
struct RecordingStateSnapshot
{
    juce::String sessionId;
    juce::String status{"idle"};
    std::optional<RecordingInputInfo> input;
    int firstChannel = 0;
    int channelCount = 1;
    int countInBars = 0;
    /** Whether the click keeps going through the take itself. Session-scoped: it
     *  starts from the project's metronome but never writes back to it. */
    bool clickEnabled = false;
    /** Input gain applied to the captured signal, in dB. */
    double inputGainDb = 0.0;
    juce::String windowMode{"playhead"};
    bool hasSelection = false;
    double anchorMs = 0.0;
    std::optional<double> windowEndMs;
    std::optional<int> countInBarsRemaining;
    double recordedMs = 0.0;
    juce::int64 droppedSamples = 0;
    juce::String errorCode;
    juce::String error;
};

/**
 * A captured recording handed to the commands layer for finalising. The
 * controller never touches the thread pool, the peaks cache or ProjectState;
 * it produces this and the caller does the offline work (ADR 0030).
 *
 * `errorCode` non-empty means the capture failed and `rawFile` is already gone.
 */
struct PendingFinalise
{
    juce::String sessionId;
    juce::String recordingId;
    juce::String suggestedName;
    juce::File rawFile;
    double sampleRate = 0.0;
    int channelCount = 1;
    /** Count-in plus round-trip latency; trimmed from the head at finalise. */
    double headTrimMs = 0.0;
    /** Capture rate as measured against the wall clock, for drift correction. */
    double measuredSampleRate = 0.0;
    double latencyMs = 0.0;
    double anchorMs = 0.0;
    double bpm = 120.0;
    double beatAnchorSec = 0.0;
    std::optional<int> musicalBeats;
    /** Length `musicalBeats` claims, in ms. The finalised file is trimmed to it so
     *  the beat count is true of the audio, not just of the record window. */
    std::optional<double> exactDurationMs;
    juce::int64 droppedSamples = 0;
    juce::String errorCode;
    juce::String error;
    /** Held so the caller can flush and close the file off the message thread. */
    std::shared_ptr<RecordingWriter> writer;
    InputCaptureTap* tap = nullptr;
};

/**
 * Drives one recording session: device lifetime, count-in, roll, the record
 * window and teardown. Message thread only, apart from the capture callback the
 * device drives into InputCaptureTap.
 *
 * The controller owns no project state and performs no disk work beyond opening
 * the growing WAV: finalising, peaks and library commit belong to
 * RecordingCommands, which schedules them off the message thread.
 */
class RecordingSessionController final : private juce::Timer
{
  public:
    RecordingSessionController();
    ~RecordingSessionController() override;

    std::function<void()> onStateChanged;
    std::function<void(float, float)> onInputLevel;
    /** Capture finished (or failed); the caller finalises off the message thread. */
    std::function<void(PendingFinalise)> onCaptureComplete;

    /** Opens the capture device and starts the session. Returns the session id,
     *  or an empty string only if a session is already open. A device that will
     *  not open still opens a session — in the `error` status, so the dialog can
     *  say what went wrong and offer another input. */
    juce::String open(AudioEngine& engine, ProjectState& projectState,
                      const juce::File& recordingsDirectory, const juce::String& typeName,
                      const juce::String& deviceName);
    void close(const juce::String& sessionId);

    bool selectInput(const juce::String& sessionId, const juce::String& typeName,
                     const juce::String& deviceName);
    bool selectChannels(const juce::String& sessionId, int firstChannel, int channelCount);
    bool setCountInBars(const juce::String& sessionId, int bars);
    /** Whether the click carries on through the take. Seeded from the project's
     *  metronome when the session opens and kept to the session: recording is not
     *  a reason for the timeline's own metronome to change. */
    bool setClickEnabled(const juce::String& sessionId, bool enabled);
    /** Input gain in dB, applied to the capture before it is written and metered.
     *  Changeable while rolling: it is a monitoring-and-capture level, and a
     *  performer who is clipping should not have to stop to fix it. */
    bool setInputGain(const juce::String& sessionId, double gainDb);
    bool setWindowMode(const juce::String& sessionId, const juce::String& mode);

    bool start(const juce::String& sessionId, const juce::String& fileBaseName,
               const juce::String& suggestedName);
    bool stop(const juce::String& sessionId);
    /** Record Again: throws the finished recording away and re-arms. */
    bool discard(const juce::String& sessionId);

    /** Called by the commands layer once the finished file exists (or failed). */
    void enterReview(const juce::String& sessionId, const juce::String& recordingId);
    void reportFailure(const juce::String& sessionId, const juce::String& errorCode,
                       const juce::String& message);

    bool hasSession() const noexcept { return session.has_value(); }
    juce::String getSessionId() const;
    juce::String getStatus() const;
    juce::String getPendingRecordingId() const;
    RecordingStateSnapshot getSnapshot() const;

  private:
    struct Session
    {
        juce::String sessionId;
        juce::String status{"idle"};
        int firstChannel = 0;
        int channelCount = 1;
        int countInBars = 0;
        bool clickEnabled = false;
        double inputGainDb = 0.0;
        juce::String windowMode{"playhead"};
        double anchorMs = 0.0;
        std::optional<double> windowEndMs;
        double transportStartMs = 0.0;
        juce::int64 rollTicks = 0;
        juce::String recordingId;
        juce::String suggestedName;
        juce::String errorCode;
        juce::String error;
        std::optional<RecordingInputInfo> input;
    };

    void timerCallback() override;
    void openDevice(const juce::String& typeName, const juce::String& deviceName);
    void closeDevice();
    void finishCapture(const juce::String& errorCode, const juce::String& message);
    void setStatus(const juce::String& status);
    void applySessionMetronome();
    double barLengthMs() const;
    void refreshWindow();

    AudioEngine* engine = nullptr;
    ProjectState* projectState = nullptr;
    juce::File recordingsDirectory;
    CaptureDevice device;
    InputCaptureTap tap;
    std::shared_ptr<RecordingWriter> writer;
    std::optional<Session> session;
    int stateTicks = 0;
};

} // namespace silverdaw::recording
