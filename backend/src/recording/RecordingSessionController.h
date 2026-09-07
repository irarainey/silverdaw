#pragma once

#include "CaptureDevice.h"
#include "InputCaptureTap.h"
#include "RecordingWriter.h"

#include <juce_events/juce_events.h>

#include <functional>
#include <cmath>
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

/** How much audio is kept in front of the anchor, and how far before the anchor the capture
 *  is opened to make sure that much exists (ADR 0030, Amendment 18).
 *
 *  Opening early is what makes the lead-in real rather than wishful: with a count-in the
 *  transport is parked until the count expires, so capture that only opened then has nothing
 *  before the anchor to keep. The open is bounded rather than moved to arm time because the
 *  head trim is *measured*: if the transport start stamp is ever unavailable the trim falls
 *  back to latency alone, and the untrimmed remainder is whatever was captured early. A
 *  quarter of a second of count-in at the head of a take is a blemish; two bars of it is a
 *  broken take. */
constexpr double kCapturePreRollMs = 250.0;
constexpr double kRecordPreRollMs = 120.0;

/** How long capture may deliver nothing before the input is declared lost
 *  (ADR 0030, Amendment 22).
 *
 *  A capture device unplugged mid-take was measured to simply stop calling back: JUCE
 *  invoked neither `audioDeviceStopped` nor `audioDeviceError`, so nothing raised the
 *  loss and the session would have gone on "recording" silence until the user noticed.
 *  A stalled callback is therefore the signal, and the only one available.
 *
 *  The threshold has to clear the longest legitimate gap by a wide margin, because a false
 *  positive aborts a take that was going fine. The slowest driver period Silverdaw will
 *  open is DirectSound's 53 ms default, so this is roughly thirty times the worst honest
 *  gap — long enough that only a genuinely dead device trips it, short enough that the
 *  performer is told while they are still standing at the microphone. */
constexpr double kCaptureStarvationMs = 1500.0;

/** Whether capture has gone quiet for long enough to call the input lost.
 *
 *  `referenceTicks` is the later of the last delivered block and the moment capture was
 *  opened, so a device that never delivers anything at all is caught by the same rule as
 *  one that dies mid-take. Pure so the threshold can be tested without a device. */
inline bool captureHasStarved(juce::int64 referenceTicks, juce::int64 nowTicks,
                              double ticksPerSecond) noexcept
{
    if (referenceTicks <= 0 || ticksPerSecond <= 0.0 || nowTicks <= referenceTicks) return false;
    const double elapsedMs =
        1000.0 * static_cast<double>(nowTicks - referenceTicks) / ticksPerSecond;
    return elapsedMs > kCaptureStarvationMs;
}

/** How a take's captured lead-in is split: what gets trimmed, and what is kept in front of
 *  the anchor. See `planHeadTrim`. */
struct HeadTrimPlan
{
    double headTrimMs = 0.0;
    double preRollMs = 0.0;
};

/**
 * Splits the audio captured ahead of the anchor into the part that is thrown away and the
 * part that is kept (ADR 0030, Amendment 18).
 *
 * `leadInMs` is the round trip plus the transport skew — everything sitting in front of the
 * anchor audio. Trimming all of it lands the take exactly on the anchor, which clips the
 * attack off a note played a hair early. Keeping `preRollMs` of it and placing the take at
 * `anchorMs - preRollMs` puts that same anchor audio back on the anchor with the early part
 * intact.
 *
 * Bounded by what was captured (a lead-in cannot be invented), by the anchor (nothing sits
 * before the start of the timeline), and refused outright when the take claims a beat count:
 * that count is divided by the whole file's duration to recover a tempo, so a lead-in would
 * make the take read as slower than it was played.
 */
inline HeadTrimPlan planHeadTrim(double leadInMs, double anchorMs, bool exactLengthClaimed)
{
    const double available = juce::jmax(0.0, leadInMs);
    const double preRoll = exactLengthClaimed
                               ? 0.0
                               : juce::jlimit(0.0, kRecordPreRollMs, juce::jmin(available, anchorMs));
    return {available - preRoll, preRoll};
}

/** Count-in is one bar or none: two bars was a choice nobody needed to make. */
constexpr int kMaxCountInBars = 1;

/** Input gain range, mirroring the dialog's slider. Never zero — a muted input is
 *  indistinguishable from a device that is delivering nothing. */
constexpr double kMinInputGainDb = -24.0;
constexpr double kMaxInputGainDb = 24.0;

/**
 * How long a count-in of `bars` lasts at `barMs`.
 *
 * A count-in clicks with the transport parked at the anchor, so it costs the
 * arrangement nothing and needs nothing in front of the anchor: **From Start**
 * counts you in from a standstill and then records from 0 ms, rather than
 * spending the count travelling and starting a bar late (ADR 0030,
 * Amendment 11). The anchor is always exactly where the user asked to record
 * from.
 */
constexpr double countInLengthMs(int bars, double barMs)
{
    return juce::jmax(0, bars) * juce::jmax(0.0, barMs);
}

/**
 * What the engine's click should be doing for a recording session in `status`,
 * given the session's own **Click While Recording** setting.
 *
 * A session only ever *borrows* the click, and it borrows it in both directions:
 * a count-in forces it on for the count, and review forces it off — the click
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

/**
 * Whether a track should be heard, given a session's backing selection.
 *
 * Backing selection is a *session* choice, borrowed the same way the click is:
 * while the dialog is open the selection alone decides what plays, and engine
 * audibility is handed straight back to the project when it closes. It is
 * borrowed in both directions — a track the timeline is muting can be ticked
 * into the backing for one take, and is muted again the moment the dialog goes —
 * because what you want to play along to is not the same question as what the
 * arrangement should sound like. Nothing here reads or writes the project's own
 * mute and solo; the seeding at `open` is what makes the default match what the
 * timeline already sounds like.
 */
constexpr bool backingTrackAudible(bool hasSession, bool selected, bool projectAudible)
{
    return hasSession ? selected : projectAudible;
}

/**
 * The arrangement monitor trim a session in this state calls for.
 *
 * Backing level is borrowed exactly like the click and the backing selection:
 * while the dialog is open the session's own trim decides how loud the
 * arrangement sits under the performer, and with no session the arrangement is
 * back at unity. It is monitoring only — nothing here reaches the project's
 * master volume, a recorded take, or a bounce.
 */
constexpr double sessionBackingGain(bool hasSession, double gain)
{
    return hasSession ? gain : 1.0;
}

/**
 * Whether input monitoring should actually be audible.
 *
 * Monitoring is only ever wanted while a session is live, and it is a feedback
 * loop waiting to happen: a monitored mic in front of a speaker will howl. So it
 * is off with no session no matter what the last session asked for, and off
 * again in review — playing a take back through a still-open monitor is the most
 * likely way to find that loop by accident.
 *
 * `ratesAgree` is the other refusal. The monitor ring hands captured frames
 * straight to the output callback one for one, so an input running at a
 * different rate from the output would be heard at the wrong pitch through a
 * ring that starves or floods continuously. Playing that back at the performer
 * is worse than not monitoring at all, and resampling on the audio thread to
 * rescue it is not worth the cost for a path nothing is recorded through.
 */
inline bool sessionMonitorAudible(bool hasSession, bool enabled, const juce::String& status,
                                  bool ratesAgree)
{
    if (! hasSession || ! enabled || ! ratesAgree) return false;
    return status != "review";
}

/**
 * Whether the capture and output devices run at the same rate, given either
 * figure may be unknown.
 *
 * Unknown means "no reason to refuse": monitoring is withheld only on a
 * mismatch that has actually been observed, never on a missing reading. The
 * tolerance is there because drivers report the nominal rate as a double.
 */
inline bool monitorRatesAgree(double captureRate, double outputRate)
{
    if (captureRate <= 0.0 || outputRate <= 0.0) return true;
    return std::abs(captureRate - outputRate) < 1.0;
}

/**
 * Whether a take should be committed as musical material.
 *
 * `music` gives the take the project's tempo and a beat count, so it snaps and
 * shows beat markers like any other loop; `simple` deliberately gives it
 * neither, because a spoken line or a found sound has no tempo and drawing beat
 * markers over it is a lie. This maps onto the library's existing `audioType`
 * rather than inventing a recording-only concept (ADR 0024).
 */
inline bool recordingModeIsMusical(const juce::String& mode) { return mode != "simple"; }

/** Where a record window sits on the timeline: its anchor, and its end when it
 *  has one. `mode` comes back normalised, because a mode can be asked for that
 *  no longer applies. */
struct RecordWindow
{
    juce::String mode;
    double anchorMs = 0.0;
    std::optional<double> endMs;
};

/**
 * Where a recording starts, and where — if anywhere — it stops on its own.
 *
 * A recording is bounded by time, never by a track (ADR 0030). Two of the three
 * windows anchor themselves and run open-ended until the performer stops: the
 * top of the project, or wherever the playhead is. Only the range window depends
 * on something outside the session, so only it can be invalidated — a range that
 * has since been cleared falls back to the playhead rather than recording over a
 * span the user can no longer see.
 */
inline RecordWindow resolveRecordWindow(const juce::String& mode,
                                        double playheadMs,
                                        bool hasSelection,
                                        double selectionStartMs,
                                        double selectionEndMs)
{
    if (mode == "selection" && hasSelection)
        return {"selection", selectionStartMs, selectionEndMs};
    if (mode == "start") return {"start", 0.0, std::nullopt};
    return {"playhead", juce::jmax(0.0, playheadMs), std::nullopt};
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
    /** Whether the click keeps going through the take itself. Session-scoped and
     *  seeded off: a fresh dialog offers no click and no count-in, and it never
     *  writes back to the project's own metronome. */
    bool clickEnabled = false;
    /** Tracks audible as backing while the session is open. Seeded with every
     *  track, so the default is the whole arrangement; an empty list records
     *  against silence. */
    juce::StringArray backingTrackIds;
    /** How loud the backing sits under the performer, 0..1. Monitoring only. */
    double backingGain = 1.0;
    /** Input gain applied to the captured signal, in dB. */
    double inputGainDb = 0.0;
    /** `music` (project tempo and beat markers) or `simple` (neither). */
    juce::String recordingMode{"music"};
    /** Whether the performer hears their own input through the monitor mix. */
    bool monitorEnabled = false;
    /** Whether monitoring can be offered at all. False when the chosen input runs at a
     *  different rate from the output device, which the monitor's one-for-one ring cannot
     *  bridge. The renderer disables the control and says why rather than letting the user
     *  turn on something that would be heard at the wrong pitch. */
    bool monitorAvailable = true;
    /** Whether the finished take gets the noise-reduction pass. */
    bool cleanupEnabled = false;
    /** Seeded to `start`: a take laid over the arrangement from the top is the
     *  one that needs no setting up, so it is what a fresh dialog offers. */
    juce::String windowMode{"start"};
    bool hasSelection = false;
    double anchorMs = 0.0;
    /** The round trip that will be trimmed off the take's head: the calibrated figure when
     *  one exists for this device pair, the drivers' own sum otherwise. Sent while a session
     *  is open because the live waveform has to draw the input where it will end up rather
     *  than where it arrived — an on-time performance arrives this long after the beat. */
    double latencyMs = 0.0;
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
    /** Lead-in deliberately left in front of the anchor, in ms, and so also how far ahead of
     *  the anchor the take belongs on the timeline. A performer often comes in a fraction
     *  early, and trimming flush to the anchor clips the front of that first note. Zero when
     *  a beat count is claimed: `musicalLengthBpm` divides the count by the whole file's
     *  duration, so a lead-in there would resolve to the wrong tempo. */
    double preRollMs = 0.0;
    /** Capture rate and output-device rate as measured against the wall clock. Their ratio
     *  is the drift; equal rates mean none. See `finishCapture`. */
    double measuredSampleRate = 0.0;
    double timelineSampleRate = 0.0;
    double latencyMs = 0.0;
    double anchorMs = 0.0;
    double bpm = 120.0;
    double beatAnchorSec = 0.0;
    std::optional<int> musicalBeats;
    /** Length `musicalBeats` claims, in ms. The finalised file is trimmed to it so
     *  the beat count is true of the audio, not just of the record window. */
    std::optional<double> exactDurationMs;
    /** `music` takes get the project tempo and a beat count; `simple` takes get
     *  neither, and commit as a plain sample. */
    bool musical = true;
    /** Whether to run the noise-reduction pass before the take is committed. */
    bool cleanup = false;
    juce::int64 droppedSamples = 0;
    /** The take ran into `kMaxRecordingSeconds` and capture was stopped for it. Deliberately
     *  NOT an `errorCode`: everything captured up to the cap is a good take and is kept, so
     *  this rides along to the review as a notice rather than failing the finalise. */
    bool hitLengthCap = false;
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
    /** Which tracks are heard as backing. Silencing is engine-only and lasts as
     *  long as the session: the project's own mute and solo are untouched. */
    bool setBackingTracks(const juce::String& sessionId, const juce::StringArray& trackIds);
    /** How loud the backing plays under the performer, 0..1. Monitoring only: it
     *  trims the arrangement in the engine, never the project's master volume or
     *  any track, and it is gone the moment the dialog closes. Changeable while
     *  rolling — it changes nothing about what is captured. */
    bool setBackingGain(const juce::String& sessionId, double gain);
    /** Input gain in dB, applied to the capture before it is written and metered.
     *  Changeable while rolling: it is a monitoring-and-capture level, and a
     *  performer who is clipping should not have to stop to fix it. */
    bool setInputGain(const juce::String& sessionId, double gainDb);
    /** `music` or `simple`. Decides whether the committed take carries the
     *  project's tempo and a beat count, so it is read at commit, not capture. */
    bool setRecordingMode(const juce::String& sessionId, const juce::String& mode);
    /** Whether the performer hears their own input in the monitor mix. Opt-in and
     *  off by default: with speakers rather than headphones it will feed back. */
    bool setMonitorEnabled(const juce::String& sessionId, bool enabled);
    /** Whether the finished take gets the noise-reduction pass at finalise. */
    bool setCleanupEnabled(const juce::String& sessionId, bool enabled);
    bool setWindowMode(const juce::String& sessionId, const juce::String& mode);
    /** The measured output-to-input round trip for this machine, in ms, or nothing to fall back
     *  to what the drivers report. Owned by the renderer because it lives in app preferences
     *  (ADR 0030, Amendment 17); the session only holds it for the next finalise. */
    bool setCalibratedRoundTripMs(const juce::String& sessionId,
                                  std::optional<double> roundTripMs);

    bool start(const juce::String& sessionId, const juce::String& fileBaseName,
               const juce::String& suggestedName);
    bool stop(const juce::String& sessionId);
    /** Record Again: throws the finished recording away and re-arms. */
    bool discard(const juce::String& sessionId);

    /** Called by the commands layer once the finished file exists (or failed). The recording
     *  id is required as well as the session id: both are answers about one particular take,
     *  and a session outlives its takes. Without it a failure from an abandoned take would
     *  land on the retry that replaced it, putting a live capture into `error` — where Stop
     *  is refused and the only way out is to close the dialog. */
    void enterReview(const juce::String& sessionId, const juce::String& recordingId);
    void reportFailure(const juce::String& sessionId, const juce::String& recordingId,
                       const juce::String& errorCode, const juce::String& message);

    bool hasSession() const noexcept { return session.has_value(); }
    /** The open capture plumbing, so a latency calibration can borrow the input the dialog
     *  already has rather than opening a second one. Null with no session; the tap outlives
     *  any one take, so a borrower must still respect the session's status. */
    CaptureDevice* getCaptureDevice() noexcept { return device.isOpen() ? &device : nullptr; }
    InputCaptureTap* getCaptureTap() noexcept { return &tap; }
    /** Puts the tap back to the session's own gain and channel selection. A borrower —
     *  currently only the latency calibration — narrows both for its own run, and the meter,
     *  the monitor and the next take must not inherit that. */
    void reapplyInputSettings();
    /** The engine the session was opened against, or null before the first open. Outlives the
     *  session deliberately: a finished take can still be auditioning through the engine's
     *  preview voice after the session has closed, and its file cannot be deleted while that
     *  reader is open. */
    AudioEngine* getEngine() noexcept { return engine; }
    /** Whether software monitoring can be offered for the open input. */
    bool isMonitorAvailable() const;
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
        juce::StringArray backingTrackIds;
        double backingGain = 1.0;
        double inputGainDb = 0.0;
        juce::String recordingMode{"music"};
        bool monitorEnabled = false;
        bool cleanupEnabled = false;
        juce::String windowMode{"start"};
        /** Measured round trip for this machine, when the user has calibrated. Preferred over
         *  the drivers' own figures at finalise, which on a processed input can be short by
         *  most of the real delay. */
        std::optional<double> calibratedRoundTripMs;
        double anchorMs = 0.0;
        std::optional<double> windowEndMs;
        double transportStartMs = 0.0;
        /** How long this take's count-in ran for. The transport is parked throughout it,
         *  so this is a UI/reporting value only — nothing is captured until it expires. */
        double countInMs = 0.0;
        juce::int64 rollTicks = 0;
        /** The play this take belongs to. A transport start stamp from any other play
         *  cannot describe this take's start, so it is refused. */
        std::uint32_t playEpoch = 0;
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
    void beginRecordingAfterCountIn();
    /** The round trip in force for this session: the calibrated measurement when one exists
     *  for the device pair, the drivers' own sum otherwise, never both (ADR 0030,
     *  Amendment 17). Shared by the head trim and the state broadcast so the number the live
     *  waveform is drawn against is the number the take is actually trimmed by. */
    double effectiveRoundTripMs() const;
    /** Attaches the writer so capture is already running when the count-in expires. Safe to
     *  call repeatedly; only the first call opens anything. */
    void openCaptureForPreRoll();
    bool beginTransport();
    double measuredTransportSkewMs() const;
    double windowStopPositionMs() const;
    void abandonCountIn();
    void setStatus(const juce::String& status);
    void applySessionMetronome();
    void applySessionBacking();
    void applySessionLoop();
    void applySessionBackingGain();
    void applySessionMonitor();
    double barLengthMs() const;
    void refreshWindow();

    AudioEngine* engine = nullptr;
    ProjectState* projectState = nullptr;
    juce::File recordingsDirectory;
    CaptureDevice device;
    InputCaptureTap tap;
    std::shared_ptr<RecordingWriter> writer;
    std::optional<Session> session;
    /** Whether the writer is attached to the tap, so a count-in tick cannot open it twice. */
    bool captureOpen = false;
    /** When capture was opened, as the starvation watchdog's reference until the device has
     *  delivered its first block. */
    juce::int64 captureOpenTicks = 0;
    int stateTicks = 0;
};

} // namespace silverdaw::recording
