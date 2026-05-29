#include "ProjectState.h"

#include <cmath>
#include <vector>

namespace silverdaw
{

const juce::Identifier ProjectState::kProject{"PROJECT"};
const juce::Identifier ProjectState::kTrack{"TRACK"};
const juce::Identifier ProjectState::kClip{"CLIP"};
const juce::Identifier ProjectState::kId{"id"};
const juce::Identifier ProjectState::kName{"name"};
const juce::Identifier ProjectState::kGain{"gain"};
const juce::Identifier ProjectState::kMuted{"muted"};
const juce::Identifier ProjectState::kSoloed{"soloed"};
const juce::Identifier ProjectState::kHeightPx{"heightPx"};
const juce::Identifier ProjectState::kFilePath{"filePath"};
const juce::Identifier ProjectState::kOffsetMs{"offsetMs"};
const juce::Identifier ProjectState::kInMs{"inMs"};
const juce::Identifier ProjectState::kDurationMs{"durationMs"};
const juce::Identifier ProjectState::kSampleRate{"sampleRate"};
const juce::Identifier ProjectState::kChannelCount{"channelCount"};
const juce::Identifier ProjectState::kColorIndex{"colorIndex"};
const juce::Identifier ProjectState::kLocked{"locked"};
const juce::Identifier ProjectState::kViewPxPerSecond{"viewPxPerSecond"};
const juce::Identifier ProjectState::kViewScrollX{"viewScrollX"};
const juce::Identifier ProjectState::kPlayheadMs{"playheadMs"};
const juce::Identifier ProjectState::kBpm{"bpm"};
const juce::Identifier ProjectState::kProjectLengthMs{"projectLengthMs"};
const juce::Identifier ProjectState::kAudioOutputTypeName{"audioOutputTypeName"};
const juce::Identifier ProjectState::kAudioOutputDeviceName{"audioOutputDeviceName"};
const juce::Identifier ProjectState::kTargetSampleRate{"targetSampleRate"};
const juce::Identifier ProjectState::kExportSettingsJson{"exportSettingsJson"};
const juce::Identifier ProjectState::kMasterVolume{"masterVolume"};
const juce::Identifier ProjectState::kLibrary{"LIBRARY"};
const juce::Identifier ProjectState::kLibraryItem{"ITEM"};
const juce::Identifier ProjectState::kMarkers{"MARKERS"};
const juce::Identifier ProjectState::kMarker{"MARKER"};
const juce::Identifier ProjectState::kPositionMs{"positionMs"};
const juce::Identifier ProjectState::kBeats{"beats"};
const juce::Identifier ProjectState::kBeatAnchorSec{"beatAnchorSec"};
const juce::Identifier ProjectState::kPlaybackFilePath{"playbackFilePath"};
const juce::Identifier ProjectState::kVariableTempo{"variableTempo"};
const juce::Identifier ProjectState::kLowConfidence{"lowConfidence"};
const juce::Identifier ProjectState::kSampleMode{"sampleMode"};
const juce::Identifier ProjectState::kKey{"key"};
const juce::Identifier ProjectState::kKind{"kind"};
const juce::Identifier ProjectState::kSourceItemId{"sourceItemId"};
const juce::Identifier ProjectState::kSourceClipId{"sourceClipId"};
const juce::Identifier ProjectState::kSourceInMs{"sourceInMs"};
const juce::Identifier ProjectState::kSourceDurationMs{"sourceDurationMs"};
const juce::Identifier ProjectState::kDisplayName{"displayName"};
const juce::Identifier ProjectState::kClipName{"clipName"};
const juce::Identifier ProjectState::kCollapsed{"collapsed"};
const juce::Identifier ProjectState::kLibraryItemId{"libraryItemId"};
const juce::Identifier ProjectState::kWarpEnabled{"warpEnabled"};
const juce::Identifier ProjectState::kWarpMode{"warpMode"};
const juce::Identifier ProjectState::kTempoRatio{"tempoRatio"};
const juce::Identifier ProjectState::kSemitones{"semitones"};
const juce::Identifier ProjectState::kCents{"cents"};
const juce::Identifier ProjectState::kPendingAutoWarp{"pendingAutoWarp"};
const juce::Identifier ProjectState::kSendReverb{"sendReverb"};
const juce::Identifier ProjectState::kSendDelay{"sendDelay"};
const juce::Identifier ProjectState::kToneBassDb{"toneBassDb"};
const juce::Identifier ProjectState::kToneMidDb{"toneMidDb"};
const juce::Identifier ProjectState::kToneTrebleDb{"toneTrebleDb"};
const juce::Identifier ProjectState::kToneLowCut{"toneLowCut"};
const juce::Identifier ProjectState::kLevelerAmount{"levelerAmount"};
const juce::Identifier ProjectState::kFadeInMs{"fadeInMs"};
const juce::Identifier ProjectState::kFadeOutMs{"fadeOutMs"};
const juce::Identifier ProjectState::kEnvelopePoints{"envelopePoints"};
const juce::Identifier ProjectState::kEnvelopeTimeMs{"timeMs"};
const juce::Identifier ProjectState::kEnvelopeGain{"gain"};
const juce::Identifier ProjectState::kReverbSize{"reverbSize"};
const juce::Identifier ProjectState::kReverbDecay{"reverbDecay"};
const juce::Identifier ProjectState::kReverbTone{"reverbTone"};
const juce::Identifier ProjectState::kReverbMix{"reverbMix"};
const juce::Identifier ProjectState::kDelayNoteValue{"delayNoteValue"};
const juce::Identifier ProjectState::kDelayFeedback{"delayFeedback"};
const juce::Identifier ProjectState::kDelayTone{"delayTone"};
const juce::Identifier ProjectState::kDelayMix{"delayMix"};

const juce::String ProjectState::kDefaultName{"Untitled"};

ProjectState::ProjectState() : root(kProject)
{
    // The initial `name=Untitled` write and the empty container children
    // happen BEFORE we attach the listener so they don't count as
    // user-initiated edits. Adding the LIBRARY / MARKERS containers up
    // front means add-then-remove cycles return to byte-identical state
    // (the containers don't appear and disappear with their contents),
    // so the clean-snapshot comparison correctly reports "clean" after
    // a net-zero edit sequence.
    root.setProperty(kName, kDefaultName, nullptr);
    root.appendChild(juce::ValueTree(kLibrary), nullptr);
    root.appendChild(juce::ValueTree(kMarkers), nullptr);
    cleanSnapshot = root.createCopy();
    root.addListener(this);
}

ProjectState::~ProjectState()
{
    root.removeListener(this);
}

void ProjectState::markClean()
{
    // Capture the current tree as the new clean baseline so subsequent
    // mutations are compared against the just-saved state. Any net-zero
    // edit sequence (e.g. add + remove a library item) will then
    // correctly return the project to its clean status.
    cleanSnapshot = root.createCopy();
    if (dirty) setDirty(false);
}

void ProjectState::markDirty()
{
    if (!dirty) setDirty(true);
}

void ProjectState::setDirtyChangedCallback(DirtyChangedCallback callback)
{
    onDirtyChanged = std::move(callback);
}

void ProjectState::setDirty(bool d)
{
    if (dirty == d) return;
    dirty = d;
    if (onDirtyChanged)
    {
        onDirtyChanged(d);
    }
}

void ProjectState::recomputeDirty()
{
    // Compare the live tree against the last clean snapshot. If they
    // match, the project has effectively returned to its saved state
    // and should be considered clean again — even if individual
    // listener callbacks tried to flip dirty=true along the way.
    if (!cleanSnapshot.isValid())
    {
        setDirty(true);
        return;
    }
    const bool actuallyDirty = !root.isEquivalentTo(cleanSnapshot);
    setDirty(actuallyDirty);
}

void ProjectState::valueTreePropertyChanged(juce::ValueTree& /*tree*/,
                                            const juce::Identifier& /*property*/)
{
    if (suppressDirtyDepth > 0) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildAdded(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/)
{
    if (suppressDirtyDepth > 0) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildRemoved(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/,
                                         int /*index*/)
{
    if (suppressDirtyDepth > 0) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildOrderChanged(juce::ValueTree& /*parent*/, int /*oldIndex*/,
                                              int /*newIndex*/)
{
    if (suppressDirtyDepth > 0) return;
    recomputeDirty();
}

void ProjectState::setNonDirtyRootProperty(const juce::Identifier& id, const juce::var& value)
{
    // Write to the live tree under suppression (no dirty transition),
    // then mirror into cleanSnapshot so the listener's equivalence
    // check never sees a delta on this property after an undo. Without
    // the mirror the tree silently drifts away from the snapshot and
    // any subsequent net-zero edit fails the equivalence test, leaving
    // the project stuck as "dirty" with nothing actually to save.
    const SuppressDirtyScope suppress(*this);
    root.setProperty(id, value, nullptr);
    if (cleanSnapshot.isValid())
        cleanSnapshot.setProperty(id, value, nullptr);
}

bool ProjectState::mutateDerivedLibraryItem(
    const juce::String& itemId,
    const std::function<void(juce::ValueTree&)>& mutator)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;

    juce::ValueTree liveItem;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            liveItem = item;
            break;
        }
    }
    if (!liveItem.isValid()) return false;

    // Suppress dirty transitions for both the live write and the
    // mirror write — the property change listener fires for any
    // descendant of `root`, so mutating a library item without
    // suppression would mark the project dirty.
    const SuppressDirtyScope suppress(*this);
    mutator(liveItem);

    if (cleanSnapshot.isValid())
    {
        auto snapLibrary = cleanSnapshot.getChildWithName(kLibrary);
        if (snapLibrary.isValid())
        {
            for (int i = 0; i < snapLibrary.getNumChildren(); ++i)
            {
                auto snapItem = snapLibrary.getChild(i);
                if (snapItem.getProperty(kId).toString() == itemId)
                {
                    mutator(snapItem);
                    break;
                }
            }
        }
    }
    return true;
}

juce::String ProjectState::getName() const
{
    const auto stored = root.getProperty(kName, kDefaultName).toString().trim();
    return stored.isEmpty() ? kDefaultName : stored;
}

void ProjectState::setName(const juce::String& name)
{
    const auto trimmed = name.trim();
    root.setProperty(kName, trimmed.isEmpty() ? kDefaultName : trimmed, &undoManager);
}

juce::ValueTree ProjectState::findTrack(const juce::String& trackId) const
{
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto child = root.getChild(i);
        if (child.hasType(kTrack) && child.getProperty(kId).toString() == trackId)
        {
            return child;
        }
    }
    return {};
}

juce::ValueTree ProjectState::findClip(const juce::String& clipId) const
{
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (clip.hasType(kClip) && clip.getProperty(kId).toString() == clipId)
            {
                return clip;
            }
        }
    }
    return {};
}

bool ProjectState::addTrack(const juce::String& trackId)
{
    if (trackId.isEmpty())
    {
        return false;
    }
    if (findTrack(trackId).isValid())
    {
        return true; // idempotent
    }
    juce::ValueTree track(kTrack);
    track.setProperty(kId, trackId, &undoManager);
    track.setProperty(kGain, 1.0F, &undoManager);
    root.appendChild(track, &undoManager);
    return true;
}

juce::StringArray ProjectState::removeTrack(const juce::String& trackId)
{
    juce::StringArray removedClipIds;
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return removedClipIds;
    }
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto clip = track.getChild(i);
        if (clip.hasType(kClip))
        {
            removedClipIds.add(clip.getProperty(kId).toString());
        }
    }
    root.removeChild(track, &undoManager);
    return removedClipIds;
}

bool ProjectState::hasTrack(const juce::String& trackId) const
{
    return findTrack(trackId).isValid();
}

bool ProjectState::moveTrack(const juce::String& trackId, int newIndex)
{
    // Only `TRACK`-typed children count toward the visible track order;
    // PROJECT may also hold LIBRARY / MARKERS at the same depth.
    int currentIndex = -1;
    int trackChildCount = 0;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto child = root.getChild(i);
        if (!child.hasType(kTrack))
            continue;
        if (child.getProperty(kId).toString() == trackId)
            currentIndex = i;
        ++trackChildCount;
    }
    if (currentIndex < 0 || trackChildCount <= 1)
        return false;
    // `newIndex` arrives in TRACK-ordinal space (i.e. ignoring sibling
    // LIBRARY / MARKERS nodes); translate it back into the absolute
    // child index ValueTree expects. We do this by walking forwards
    // skipping non-TRACK children until we've stepped over `newIndex`
    // tracks.
    const int clampedOrdinal = juce::jlimit(0, trackChildCount - 1, newIndex);
    int absoluteTarget = -1;
    int seen = 0;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        if (!root.getChild(i).hasType(kTrack))
            continue;
        if (seen == clampedOrdinal)
        {
            absoluteTarget = i;
            break;
        }
        ++seen;
    }
    if (absoluteTarget < 0 || absoluteTarget == currentIndex)
        return false;
    root.moveChild(currentIndex, absoluteTarget, &undoManager);
    return true;
}

float ProjectState::getTrackGain(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 1.0F;
    }
    return static_cast<float>(static_cast<double>(track.getProperty(kGain, 1.0)));
}

bool ProjectState::getTrackMuted(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return static_cast<bool>(track.getProperty(kMuted, false));
}

bool ProjectState::getTrackSoloed(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return static_cast<bool>(track.getProperty(kSoloed, false));
}

bool ProjectState::anyTrackSoloed() const
{
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto track = root.getChild(i);
        if (!track.hasType(kTrack)) continue;
        if (static_cast<bool>(track.getProperty(kSoloed, false))) return true;
    }
    return false;
}

float ProjectState::getEffectiveTrackGain(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0F;
    const bool muted = static_cast<bool>(track.getProperty(kMuted, false));
    if (muted) return 0.0F;
    const bool soloed = static_cast<bool>(track.getProperty(kSoloed, false));
    if (anyTrackSoloed() && !soloed) return 0.0F;
    return static_cast<float>(static_cast<double>(track.getProperty(kGain, 1.0)));
}

bool ProjectState::setTrackName(const juce::String& trackId, const juce::String& name)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    const auto trimmed = name.trim();
    if (trimmed.isEmpty())
    {
        return false;
    }
    track.setProperty(kName, trimmed, &undoManager);
    return true;
}

bool ProjectState::setTrackGain(const juce::String& trackId, float gain)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    track.setProperty(kGain, gain, &undoManager);
    return true;
}

bool ProjectState::setTrackMuted(const juce::String& trackId, bool muted)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    if (muted)
    {
        track.setProperty(kMuted, true, &undoManager);
    }
    else
    {
        // Drop the property entirely when false so saved files don't
        // accumulate `muted: false` noise. Same convention as the rest
        // of the codebase (e.g. variableTempo, lowConfidence).
        track.removeProperty(kMuted, &undoManager);
    }
    return true;
}

bool ProjectState::setTrackSoloed(const juce::String& trackId, bool soloed)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    if (soloed)
    {
        track.setProperty(kSoloed, true, &undoManager);
    }
    else
    {
        track.removeProperty(kSoloed, &undoManager);
    }
    return true;
}

// Per-track row height clamps. Must agree with the renderer's
// MIN_TRACK_HEIGHT / MAX_TRACK_HEIGHT in
// `frontend/src/renderer/src/lib/timeline/constants.ts` so the backend
// rejects values outside the resize-handle's range.
static constexpr double kMinTrackHeightPx = 60.0;
static constexpr double kMaxTrackHeightPx = 400.0;

double ProjectState::getTrackHeightPx(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 0.0;
    }
    return static_cast<double>(track.getProperty(kHeightPx, 0.0));
}

bool ProjectState::setTrackHeightPx(const juce::String& trackId, double heightPx)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    const auto clamped = juce::jlimit(kMinTrackHeightPx, kMaxTrackHeightPx, heightPx);
    track.setProperty(kHeightPx, clamped, &undoManager);
    return true;
}

// Float-precision tolerance for the per-track send setters. A drag
// gesture that lands within ~1e-4 of zero is treated as "off" so the
// property is removed from the tree, keeping legacy snapshots
// byte-equivalent and avoiding silent dirty-flagging from noisy UI
// streams. Same epsilon is used to compare against the prior stored
// value to decide whether anything actually changed.
static constexpr float kSendEpsilon = 1.0e-4f;

static bool nearlyZero(float value) noexcept
{
    return std::abs(value) < kSendEpsilon;
}

static bool nearlyEqual(float a, float b) noexcept
{
    return std::abs(a - b) < kSendEpsilon;
}

// Apply a `[0, 1]`-clamped float to `track` under `id`, mirroring the
// "absent == default(0)" convention used by every other Phase 5 setter.
// Returns `true` iff the persisted shape actually changed.
static bool applyClampedSend(juce::ValueTree& track,
                             const juce::Identifier& id,
                             float value,
                             juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(0.0f, 1.0f, value);
    const bool hadProperty = track.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(track.getProperty(id)))
        : 0.0f;

    if (nearlyZero(clamped))
    {
        if (!hadProperty)
        {
            return false;
        }
        track.removeProperty(id, undo);
        return true;
    }

    if (hadProperty && nearlyEqual(previous, clamped))
    {
        return false;
    }
    track.setProperty(id, clamped, undo);
    return true;
}

bool ProjectState::setTrackSends(const juce::String& trackId, float reverbSend, float delaySend)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    const bool reverbChanged = applyClampedSend(track, kSendReverb, reverbSend, &undoManager);
    const bool delayChanged = applyClampedSend(track, kSendDelay, delaySend, &undoManager);
    return reverbChanged || delayChanged;
}

float ProjectState::getTrackReverbSend(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 0.0f;
    }
    return static_cast<float>(static_cast<double>(track.getProperty(kSendReverb, 0.0)));
}

float ProjectState::getTrackDelaySend(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 0.0f;
    }
    return static_cast<float>(static_cast<double>(track.getProperty(kSendDelay, 0.0)));
}

// ─── Phase 5: per-track Tone / Leveler, per-clip Fades / Envelope,
// ─── project-shared Reverb / Delay. All follow the same
// ─── default-suppression contract as `setTrackSends`: setters return
// ─── `true` only when the stored shape changes, so dispatchers can
// ─── skip ack/undo/dirty on no-op writes.

// Per-parameter epsilons. dB knobs are perceptibly stable around
// ~0.01 dB; ms knobs at the sub-millisecond level are below the
// renderer's pixel resolution.
static constexpr float kToneDbEpsilon = 1.0e-3f;
static constexpr float kLevelerEpsilon = 1.0e-4f;
static constexpr double kFadeMsEpsilon = 1.0e-2;
static constexpr float kReverbEpsilon = 1.0e-4f;
static constexpr float kDelayEpsilon = 1.0e-4f;

static bool applyClampedDb(juce::ValueTree& tree,
                           const juce::Identifier& id,
                           float value,
                           juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(-12.0f, 12.0f, value);
    const bool hadProperty = tree.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(tree.getProperty(id)))
        : 0.0f;
    if (std::abs(clamped) < kToneDbEpsilon)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && std::abs(previous - clamped) < kToneDbEpsilon) return false;
    tree.setProperty(id, clamped, undo);
    return true;
}

static bool applyUnitFloat(juce::ValueTree& tree,
                           const juce::Identifier& id,
                           float value,
                           float epsilon,
                           juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(0.0f, 1.0f, value);
    const bool hadProperty = tree.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(tree.getProperty(id)))
        : 0.0f;
    if (std::abs(clamped) < epsilon)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && std::abs(previous - clamped) < epsilon) return false;
    tree.setProperty(id, clamped, undo);
    return true;
}

static bool applyBoolDefaultFalse(juce::ValueTree& tree,
                                  const juce::Identifier& id,
                                  bool value,
                                  juce::UndoManager* undo)
{
    const bool hadProperty = tree.hasProperty(id);
    if (!value)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && static_cast<bool>(tree.getProperty(id))) return false;
    tree.setProperty(id, true, undo);
    return true;
}

bool ProjectState::setTrackTone(const juce::String& trackId, float bassDb, float midDb,
                                float trebleDb, bool lowCut)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    bool changed = false;
    changed |= applyClampedDb(track, kToneBassDb, bassDb, &undoManager);
    changed |= applyClampedDb(track, kToneMidDb, midDb, &undoManager);
    changed |= applyClampedDb(track, kToneTrebleDb, trebleDb, &undoManager);
    changed |= applyBoolDefaultFalse(track, kToneLowCut, lowCut, &undoManager);
    return changed;
}

float ProjectState::getTrackToneBassDb(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kToneBassDb, 0.0)));
}

float ProjectState::getTrackToneMidDb(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kToneMidDb, 0.0)));
}

float ProjectState::getTrackToneTrebleDb(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kToneTrebleDb, 0.0)));
}

bool ProjectState::getTrackToneLowCut(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return static_cast<bool>(track.getProperty(kToneLowCut, false));
}

bool ProjectState::setTrackLevelerAmount(const juce::String& trackId, float amount)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return applyUnitFloat(track, kLevelerAmount, amount, kLevelerEpsilon, &undoManager);
}

float ProjectState::getTrackLevelerAmount(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kLevelerAmount, 0.0)));
}

// Apply a non-negative ms value to a clip under `id` with the
// fade-default-suppression discipline. Negative inputs clamp to 0.
// Runtime is responsible for `fadeIn + fadeOut <= clipDuration`;
// this storage layer only enforces non-negativity.
static bool applyClipMs(juce::ValueTree& clip,
                        const juce::Identifier& id,
                        double valueMs,
                        juce::UndoManager* undo)
{
    const auto clamped = juce::jmax(0.0, valueMs);
    const bool hadProperty = clip.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<double>(clip.getProperty(id))
        : 0.0;
    if (clamped < kFadeMsEpsilon)
    {
        if (!hadProperty) return false;
        clip.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && std::abs(previous - clamped) < kFadeMsEpsilon) return false;
    clip.setProperty(id, clamped, undo);
    return true;
}

bool ProjectState::setClipFades(const juce::String& clipId, double fadeInMs, double fadeOutMs)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    bool changed = false;
    changed |= applyClipMs(clip, kFadeInMs, fadeInMs, &undoManager);
    changed |= applyClipMs(clip, kFadeOutMs, fadeOutMs, &undoManager);
    return changed;
}

double ProjectState::getClipFadeInMs(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return 0.0;
    return static_cast<double>(clip.getProperty(kFadeInMs, 0.0));
}

double ProjectState::getClipFadeOutMs(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return 0.0;
    return static_cast<double>(clip.getProperty(kFadeOutMs, 0.0));
}

// Returns the existing envelope array as a copy or an empty array if
// the property is absent. Used both by `getClipEnvelope` for outside
// callers and for change-detection inside the setter.
static juce::Array<juce::var> readEnvelopeArray(const juce::ValueTree& clip,
                                                const juce::Identifier& id)
{
    if (!clip.hasProperty(id)) return {};
    const auto& v = clip.getProperty(id);
    if (!v.isArray()) return {};
    return *v.getArray();
}

static bool envelopeArraysSemanticallyEqual(const juce::Array<juce::var>& a,
                                            const juce::Array<juce::var>& b,
                                            const juce::Identifier& timeId,
                                            const juce::Identifier& gainId)
{
    if (a.size() != b.size()) return false;
    for (int i = 0; i < a.size(); ++i)
    {
        const double ta = static_cast<double>(a.getReference(i).getProperty(timeId, 0.0));
        const double tb = static_cast<double>(b.getReference(i).getProperty(timeId, 0.0));
        const double ga = static_cast<double>(a.getReference(i).getProperty(gainId, 1.0));
        const double gb = static_cast<double>(b.getReference(i).getProperty(gainId, 1.0));
        if (std::abs(ta - tb) > 1.0e-3 || std::abs(ga - gb) > 1.0e-4) return false;
    }
    return true;
}

bool ProjectState::setClipEnvelope(const juce::String& clipId,
                                   const juce::Array<juce::var>& points)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;

    // Normalise: clamp, sort ascending by timeMs, reject duplicate
    // times. An empty input array clears the envelope entirely
    // (property removed) — that's the "default" shape that round-trips
    // legacy projects unchanged.
    juce::Array<juce::var> normalised;
    normalised.ensureStorageAllocated(points.size());
    for (const auto& p : points)
    {
        if (!p.isObject()) return false;
        const double t = static_cast<double>(p.getProperty(kEnvelopeTimeMs, 0.0));
        const double g = static_cast<double>(p.getProperty(kEnvelopeGain, 1.0));
        const double clampedTime = juce::jmax(0.0, t);
        const double clampedGain = juce::jlimit(0.0, 4.0, g);
        auto* obj = new juce::DynamicObject();
        obj->setProperty(kEnvelopeTimeMs, clampedTime);
        obj->setProperty(kEnvelopeGain, clampedGain);
        normalised.add(juce::var(obj));
    }
    std::sort(normalised.begin(), normalised.end(),
              [](const juce::var& a, const juce::var& b) {
                  return static_cast<double>(a.getProperty("timeMs", 0.0)) <
                         static_cast<double>(b.getProperty("timeMs", 0.0));
              });
    for (int i = 1; i < normalised.size(); ++i)
    {
        const double prev = static_cast<double>(normalised.getReference(i - 1).getProperty(kEnvelopeTimeMs, 0.0));
        const double curr = static_cast<double>(normalised.getReference(i).getProperty(kEnvelopeTimeMs, 0.0));
        if (std::abs(curr - prev) < 1.0e-3) return false; // duplicate timeMs
    }

    const auto existing = readEnvelopeArray(clip, kEnvelopePoints);
    if (normalised.isEmpty())
    {
        if (!clip.hasProperty(kEnvelopePoints)) return false;
        clip.removeProperty(kEnvelopePoints, &undoManager);
        return true;
    }
    if (envelopeArraysSemanticallyEqual(existing, normalised, kEnvelopeTimeMs, kEnvelopeGain))
    {
        return false;
    }
    clip.setProperty(kEnvelopePoints, juce::var(normalised), &undoManager);
    return true;
}

juce::Array<juce::var> ProjectState::getClipEnvelope(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return {};
    return readEnvelopeArray(clip, kEnvelopePoints);
}

bool ProjectState::setProjectReverb(float size, float decay, float tone, float mix)
{
    bool changed = false;
    changed |= applyUnitFloat(root, kReverbSize, size, kReverbEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kReverbDecay, decay, kReverbEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kReverbTone, tone, kReverbEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kReverbMix, mix, kReverbEpsilon, &undoManager);
    return changed;
}

float ProjectState::getProjectReverbSize() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kReverbSize, 0.0)));
}
float ProjectState::getProjectReverbDecay() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kReverbDecay, 0.0)));
}
float ProjectState::getProjectReverbTone() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kReverbTone, 0.0)));
}
float ProjectState::getProjectReverbMix() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kReverbMix, 0.0)));
}

// Whitelist of legal delay note values. Anything else (including
// whitespace variants like " 1/8" or case mismatches) is rejected
// without mutating the tree so the persisted shape can't get into
// an unknown state via a hostile / mis-versioned client.
static bool isLegalDelayNoteValue(const juce::String& v)
{
    return v == "1/4" || v == "1/8" || v == "1/8T" || v == "1/16";
}

bool ProjectState::setProjectDelay(const juce::String& noteValue, float feedback,
                                   float tone, float mix)
{
    if (!isLegalDelayNoteValue(noteValue)) return false;

    bool changed = false;

    // Default note value is "1/8" — suppress that exact string so a
    // never-touched delay project rounds-trips with no property set.
    const bool hadNote = root.hasProperty(kDelayNoteValue);
    const auto prevNote = hadNote ? root.getProperty(kDelayNoteValue).toString() : juce::String("1/8");
    if (noteValue == "1/8")
    {
        if (hadNote) { root.removeProperty(kDelayNoteValue, &undoManager); changed = true; }
    }
    else if (!hadNote || prevNote != noteValue)
    {
        root.setProperty(kDelayNoteValue, noteValue, &undoManager);
        changed = true;
    }

    changed |= applyUnitFloat(root, kDelayFeedback, feedback, kDelayEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kDelayTone, tone, kDelayEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kDelayMix, mix, kDelayEpsilon, &undoManager);
    return changed;
}

juce::String ProjectState::getProjectDelayNoteValue() const
{
    return root.getProperty(kDelayNoteValue, "1/8").toString();
}
float ProjectState::getProjectDelayFeedback() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kDelayFeedback, 0.0)));
}
float ProjectState::getProjectDelayTone() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kDelayTone, 0.0)));
}
float ProjectState::getProjectDelayMix() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kDelayMix, 0.0)));
}

juce::StringArray ProjectState::getTrackClipIds(const juce::String& trackId) const
{
    juce::StringArray ids;
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return ids;
    }
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto clip = track.getChild(i);
        if (clip.hasType(kClip))
        {
            ids.add(clip.getProperty(kId).toString());
        }
    }
    return ids;
}

// `addClip` carries multiple adjacent `juce::String` parameters because the
// bridge envelope itself uses two distinct string fields. The parameter
// order is a load-bearing wire-protocol convention; swapping is silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
bool ProjectState::addClip(const juce::String& trackId, const juce::String& clipId, const juce::String& libraryItemId,
                           double offsetMs, double durationMs, double inMs, int colorIndex)
{
    if (trackId.isEmpty() || clipId.isEmpty() || libraryItemId.isEmpty())
    {
        return false;
    }
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    if (findClip(clipId).isValid())
    {
        return false; // id collision anywhere in the tree
    }
    juce::ValueTree clip(kClip);
    clip.setProperty(kId, clipId, &undoManager);
    clip.setProperty(kLibraryItemId, libraryItemId, &undoManager);
    clip.setProperty(kOffsetMs, offsetMs, &undoManager);
    clip.setProperty(kInMs, inMs, &undoManager);
    clip.setProperty(kDurationMs, durationMs, &undoManager);
    if (colorIndex >= 0)
    {
        clip.setProperty(kColorIndex, colorIndex, &undoManager);
    }
    track.appendChild(clip, &undoManager);
    return true;
}

bool ProjectState::removeClip(const juce::String& clipId)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    auto parent = clip.getParent();
    parent.removeChild(clip, &undoManager);
    return true;
}

bool ProjectState::setClipOffsetMs(const juce::String& clipId, double offsetMs)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    clip.setProperty(kOffsetMs, offsetMs, &undoManager);
    return true;
}

bool ProjectState::setClipTrack(const juce::String& clipId, const juce::String& newTrackId)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    auto destTrack = findTrack(newTrackId);
    if (!destTrack.isValid())
    {
        return false;
    }
    auto oldParent = clip.getParent();
    if (oldParent == destTrack)
    {
        return true; // already on the destination track
    }
    // ValueTree nodes can only have one parent; removeChild +
    // appendChild on the same ValueTree object preserves the node
    // (including its sub-properties).
    oldParent.removeChild(clip, &undoManager);
    destTrack.appendChild(clip, &undoManager);
    return true;
}

bool ProjectState::setClipTrim(const juce::String& clipId, double offsetMs, double inMs, double durationMs)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    // Three writes on the same clip node coalesce into a single dirty
    // transition because `setDirty(true)` is a no-op when already true.
    clip.setProperty(kOffsetMs, offsetMs, &undoManager);
    clip.setProperty(kInMs, inMs, &undoManager);
    clip.setProperty(kDurationMs, durationMs, &undoManager);
    return true;
}

double ProjectState::getClipInMs(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return 0.0;
    return static_cast<double>(clip.getProperty(kInMs, 0.0));
}

double ProjectState::getClipDurationMs(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return 0.0;
    return static_cast<double>(clip.getProperty(kDurationMs, 0.0));
}

bool ProjectState::setClipColorIndex(const juce::String& clipId, int colorIndex)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    if (colorIndex < 0)
    {
        // Negative = remove the per-clip override and inherit the
        // host-track colour at render time.
        clip.removeProperty(kColorIndex, &undoManager);
    }
    else
    {
        clip.setProperty(kColorIndex, colorIndex, &undoManager);
    }
    return true;
}

bool ProjectState::setClipLocked(const juce::String& clipId, bool locked)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    if (locked)
    {
        clip.setProperty(kLocked, true, &undoManager);
    }
    else
    {
        // Remove the property so absent==unlocked on disk and on the
        // wire. Matches the colorIndex / clipName conventions.
        clip.removeProperty(kLocked, &undoManager);
    }
    return true;
}

bool ProjectState::isClipLocked(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    return static_cast<bool>(clip.getProperty(kLocked, false));
}

bool ProjectState::setClipFilePath(const juce::String& clipId, const juce::String& filePath)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    clip.setProperty(kFilePath, filePath, &undoManager);
    return true;
}

juce::String ProjectState::getClipLibraryItemId(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return {};
    return clip.getProperty(kLibraryItemId, {}).toString();
}

bool ProjectState::setClipLibraryItemId(const juce::String& clipId, const juce::String& libraryItemId)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    clip.setProperty(kLibraryItemId, libraryItemId, &undoManager);
    return true;
}

bool ProjectState::setClipName(const juce::String& clipId, const juce::String& name)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    const auto trimmed = name.trim();
    if (trimmed.isEmpty())
    {
        clip.removeProperty(kClipName, &undoManager);
    }
    else
    {
        clip.setProperty(kClipName, trimmed, &undoManager);
    }
    return true;
}

juce::String ProjectState::getClipName(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return {};
    return clip.getProperty(kClipName, {}).toString();
}

void ProjectState::forEachWarpClip(const std::function<void(const WarpClipInfo&)>& visitor) const
{
    if (!visitor) return;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(kTrack)) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(kClip)) continue;
            WarpClipInfo info;
            info.clipId = clip.getProperty(kId).toString();
            info.libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
            info.warpEnabled = static_cast<bool>(clip.getProperty(kWarpEnabled, false));
            info.tempoRatioPinned = clip.hasProperty(kTempoRatio);
            info.tempoRatio = static_cast<double>(clip.getProperty(kTempoRatio, 1.0));
            info.semitones = static_cast<double>(clip.getProperty(kSemitones, 0.0));
            info.cents = static_cast<double>(clip.getProperty(kCents, 0.0));
            info.warpMode = clip.getProperty(kWarpMode, "rhythmic").toString();
            info.pendingAutoWarp = static_cast<bool>(clip.getProperty(kPendingAutoWarp, false));
            visitor(info);
        }
    }
}

ProjectState::EffectiveClipTiming ProjectState::getClipEffectiveTiming(const juce::String& clipId) const
{
    EffectiveClipTiming out;
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return out;

    out.durationMs = static_cast<double>(clip.getProperty(kDurationMs, 0.0));
    if (!static_cast<bool>(clip.getProperty(kWarpEnabled, false)))
    {
        return out;
    }

    double ratio = 1.0;
    if (clip.hasProperty(kTempoRatio))
    {
        ratio = static_cast<double>(clip.getProperty(kTempoRatio, 1.0));
    }
    else
    {
        const auto libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
        const double sourceBpm = getLibraryItemBpm(libraryItemId);
        const double projectBpm = getBpm();
        if (sourceBpm > 0.0 && projectBpm > 0.0)
        {
            ratio = projectBpm / sourceBpm;
        }
    }

    out.tempoRatio = ratio > 0.0 ? ratio : 1.0;
    out.warpActive = std::abs(out.tempoRatio - 1.0) > 1.0e-4;
    if (out.warpActive)
    {
        out.durationMs = out.durationMs / out.tempoRatio;
    }
    return out;
}

double ProjectState::getLibraryItemBpm(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return 0.0;
    juce::String sourceItemId;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            const auto bpm = static_cast<double>(item.getProperty(kBpm, 0.0));
            if (bpm > 0.0) return bpm;
            sourceItemId = item.getProperty(kSourceItemId, {}).toString();
            break;
        }
    }
    if (sourceItemId.isNotEmpty())
    {
        for (int i = 0; i < library.getNumChildren(); ++i)
        {
            const auto item = library.getChild(i);
            if (item.getProperty(kId).toString() == sourceItemId)
            {
                return static_cast<double>(item.getProperty(kBpm, 0.0));
            }
        }
    }
    return 0.0;
}

bool ProjectState::setClipWarp(const juce::String& clipId,
                               std::optional<bool> warpEnabled,
                               std::optional<juce::String> warpMode,
                               std::optional<double> tempoRatio,
                               bool tempoRatioClear,
                               std::optional<double> semitones,
                               std::optional<double> cents,
                               std::optional<bool> pendingAutoWarp)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    if (warpEnabled.has_value())
    {
        clip.setProperty(kWarpEnabled, *warpEnabled, &undoManager);
    }
    if (warpMode.has_value() && warpMode->isNotEmpty())
    {
        // The mode strings used on the wire are validated by the bridge
        // dispatch site; we trust them once they reach here.
        clip.setProperty(kWarpMode, *warpMode, &undoManager);
    }
    if (tempoRatioClear)
    {
        clip.removeProperty(kTempoRatio, &undoManager);
    }
    else if (tempoRatio.has_value())
    {
        // Clamp to a sane band so a hostile payload can't ask Rubber Band
        // to stretch by 1000x. 0.25 = quarter speed, 4.0 = quadruple
        // speed; outside this band the audible artefacts dominate the
        // result anyway.
        const auto clamped = juce::jlimit(0.25, 4.0, *tempoRatio);
        clip.setProperty(kTempoRatio, clamped, &undoManager);
    }
    if (semitones.has_value())
    {
        const auto clamped = juce::jlimit(-24.0, 24.0, *semitones);
        clip.setProperty(kSemitones, clamped, &undoManager);
    }
    if (cents.has_value())
    {
        const auto clamped = juce::jlimit(-100.0, 100.0, *cents);
        clip.setProperty(kCents, clamped, &undoManager);
    }
    if (pendingAutoWarp.has_value())
    {
        if (*pendingAutoWarp)
        {
            clip.setProperty(kPendingAutoWarp, true, &undoManager);
        }
        else
        {
            clip.removeProperty(kPendingAutoWarp, &undoManager);
        }
    }
    return true;
}

juce::String ProjectState::getClipTrackId(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return {};
    }
    return clip.getParent().getProperty(kId).toString();
}

juce::String ProjectState::getClipFilePath(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return {};
    }
    // Source-of-truth is the linked library item; fall back to a
    // legacy `filePath` property if present (older projects that
    // pre-date the library-item-id refactor).
    const juce::String libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
    if (libraryItemId.isNotEmpty())
    {
        const auto path = getLibraryItemFilePath(libraryItemId);
        if (path.isNotEmpty()) return path;
    }
    return clip.getProperty(kFilePath, {}).toString();
}

double ProjectState::getViewPxPerSecond() const
{
    // 100 px/s default matches the renderer's `DEFAULT_PX_PER_SECOND` so
    // a freshly-created project opens at the same zoom that was used
    // before this preference existed.
    return static_cast<double>(root.getProperty(kViewPxPerSecond, 100.0));
}

void ProjectState::setViewPxPerSecond(double pxPerSecond)
{
    // Zoom is view state, same as scroll — never marks dirty, and
    // mirrored into cleanSnapshot so a later undo cleanly returns to
    // the un-dirty baseline.
    setNonDirtyRootProperty(kViewPxPerSecond, pxPerSecond);
}

double ProjectState::getViewScrollX() const
{
    return static_cast<double>(root.getProperty(kViewScrollX, 0.0));
}

void ProjectState::setViewScrollX(double scrollX)
{
    // Scroll is a view setting — never marks dirty, and mirrored into
    // cleanSnapshot so a later undo cleanly returns to the un-dirty
    // baseline.
    setNonDirtyRootProperty(kViewScrollX, scrollX);
}

double ProjectState::getPlayheadMs() const
{
    return static_cast<double>(root.getProperty(kPlayheadMs, 0.0));
}

void ProjectState::setPlayheadMs(double playheadMs)
{
    // Playhead position is a transient transport / view value — never
    // marks dirty. Seeks/stops mirror into this property, and save
    // captures the current engine position immediately before writing.
    // Mirrored into cleanSnapshot so transport movement post-markClean
    // doesn't leave the project stuck dirty after a net-zero edit+undo.
    setNonDirtyRootProperty(kPlayheadMs, playheadMs);
}

double ProjectState::getBpm() const
{
    return static_cast<double>(root.getProperty(kBpm, 100.0));
}

void ProjectState::setBpm(double bpm)
{
    // Tempo is a meaningful project edit; record via the undo manager
    // so Ctrl+Z reverts a tempo change.
    root.setProperty(kBpm, bpm, &undoManager);
}

double ProjectState::getProjectLengthMs() const
{
    return static_cast<double>(root.getProperty(kProjectLengthMs, 0.0));
}

void ProjectState::setProjectLengthMs(double lengthMs)
{
    // Length is a meaningful edit (the user explicitly chose this
    // length via the transport bar) — recorded for undo.
    root.setProperty(kProjectLengthMs, lengthMs, &undoManager);
}

juce::String ProjectState::getAudioOutputTypeName() const
{
    return root.getProperty(kAudioOutputTypeName, "").toString();
}

juce::String ProjectState::getAudioOutputDeviceName() const
{
    return root.getProperty(kAudioOutputDeviceName, "").toString();
}

void ProjectState::setAudioOutput(const juce::String& typeName, const juce::String& deviceName)
{
    // Empty strings are persisted as absent properties so projects
    // without a preference don't carry the keys forward at all.
    if (typeName.isEmpty())
    {
        root.removeProperty(kAudioOutputTypeName, &undoManager);
    }
    else
    {
        root.setProperty(kAudioOutputTypeName, typeName, &undoManager);
    }
    if (deviceName.isEmpty())
    {
        root.removeProperty(kAudioOutputDeviceName, &undoManager);
    }
    else
    {
        root.setProperty(kAudioOutputDeviceName, deviceName, &undoManager);
    }
}

int ProjectState::getTargetSampleRate() const
{
    return static_cast<int>(root.getProperty(kTargetSampleRate, 0));
}

void ProjectState::setTargetSampleRate(int sampleRate)
{
    // Empty value is persisted as an absent property so projects that
    // never set the field don't carry the key forward at all. Same
    // shape as the audio-output preference.
    if (sampleRate <= 0)
    {
        root.removeProperty(kTargetSampleRate, &undoManager);
    }
    else
    {
        root.setProperty(kTargetSampleRate, sampleRate, &undoManager);
    }
}

juce::String ProjectState::getExportSettingsJson() const
{
    return root.getProperty(kExportSettingsJson, "").toString();
}

void ProjectState::setExportSettingsJson(const juce::String& json)
{
    // No undo entry (export prefs are not part of the editing undo
    // stack). Pass nullptr so the value-tree mutation doesn't get
    // attached to any open transaction. The listener still fires so
    // dirty tracking + clean-snapshot comparison work normally.
    if (json.isEmpty())
    {
        root.removeProperty(kExportSettingsJson, nullptr);
    }
    else
    {
        root.setProperty(kExportSettingsJson, json, nullptr);
    }
}

float ProjectState::getMasterVolume() const
{
    // Default unity when absent. Property is only stored when the
    // user has moved the master slider, keeping legacy projects
    // round-trip clean.
    return static_cast<float>(static_cast<double>(root.getProperty(kMasterVolume, 1.0)));
}

void ProjectState::setMasterVolume(float volume)
{
    const float clamped = juce::jlimit(0.0F, 1.0F, volume);
    if (juce::approximatelyEqual(clamped, 1.0F))
    {
        root.removeProperty(kMasterVolume, &undoManager);
    }
    else
    {
        root.setProperty(kMasterVolume, clamped, &undoManager);
    }
}

bool ProjectState::addLibraryItem(const juce::String& itemId, const juce::String& filePath, const juce::String& fileName,
                                   double durationMs, int sampleRate, int channelCount,
                                   const juce::String& playbackPath, const juce::String& key,
                                   const juce::String& kind, const juce::String& displayName,
                                   const juce::String& sourceItemId, const juce::String& sourceClipId,
                                   double sourceInMs, double sourceDurationMs,
                                   int collapsedFlag)
{
    if (itemId.isEmpty() || filePath.isEmpty()) return false;
    const auto normalisedKind = kind == "saved-clip" ? juce::String("saved-clip") : juce::String("audio-file");
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid())
    {
        library = juce::ValueTree(kLibrary);
        root.appendChild(library, nullptr);
    }
    // If an item with the same id already exists, just update its
    // filePath — covers the relink-from-library case and is more
    // forgiving than a hard-fail.
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            item.setProperty(kFilePath, filePath, &undoManager);
            item.setProperty(kKind, normalisedKind, &undoManager);
            if (displayName.isNotEmpty())
            {
                item.setProperty(kDisplayName, displayName, &undoManager);
            }
            if (fileName.isNotEmpty())
            {
                item.setProperty(kName, fileName, &undoManager);
            }
            if (durationMs > 0.0)
            {
                item.setProperty(kDurationMs, durationMs, &undoManager);
            }
            if (sampleRate > 0)
            {
                item.setProperty(kSampleRate, sampleRate, &undoManager);
            }
            if (channelCount > 0)
            {
                item.setProperty(kChannelCount, channelCount, &undoManager);
            }
            if (playbackPath.isNotEmpty())
            {
                item.setProperty(kPlaybackFilePath, playbackPath, &undoManager);
            }
            if (key.isNotEmpty())
            {
                item.setProperty(kKey, key, &undoManager);
            }
            if (sourceItemId.isNotEmpty())
            {
                item.setProperty(kSourceItemId, sourceItemId, &undoManager);
            }
            if (sourceClipId.isNotEmpty())
            {
                item.setProperty(kSourceClipId, sourceClipId, &undoManager);
            }
            if (sourceInMs >= 0.0)
            {
                item.setProperty(kSourceInMs, sourceInMs, &undoManager);
            }
            if (sourceDurationMs >= 0.0)
            {
                item.setProperty(kSourceDurationMs, sourceDurationMs, &undoManager);
            }
            if (collapsedFlag == 1)
            {
                item.setProperty(kCollapsed, true, &undoManager);
            }
            else if (collapsedFlag == 0)
            {
                item.removeProperty(kCollapsed, &undoManager);
            }
            return true;
        }
    }
    juce::ValueTree item(kLibraryItem);
    item.setProperty(kId, itemId, nullptr);
    item.setProperty(kFilePath, filePath, nullptr);
    item.setProperty(kKind, normalisedKind, nullptr);
    if (displayName.isNotEmpty())
    {
        item.setProperty(kDisplayName, displayName, nullptr);
    }
    if (fileName.isNotEmpty())
    {
        item.setProperty(kName, fileName, nullptr);
    }
    if (durationMs > 0.0)
    {
        item.setProperty(kDurationMs, durationMs, nullptr);
    }
    if (sampleRate > 0)
    {
        item.setProperty(kSampleRate, sampleRate, nullptr);
    }
    if (channelCount > 0)
    {
        item.setProperty(kChannelCount, channelCount, nullptr);
    }
    if (playbackPath.isNotEmpty())
    {
        item.setProperty(kPlaybackFilePath, playbackPath, nullptr);
    }
    if (key.isNotEmpty())
    {
        item.setProperty(kKey, key, nullptr);
    }
    if (sourceItemId.isNotEmpty())
    {
        item.setProperty(kSourceItemId, sourceItemId, nullptr);
    }
    if (sourceClipId.isNotEmpty())
    {
        item.setProperty(kSourceClipId, sourceClipId, nullptr);
    }
    if (sourceInMs >= 0.0)
    {
        item.setProperty(kSourceInMs, sourceInMs, nullptr);
    }
    if (sourceDurationMs >= 0.0)
    {
        item.setProperty(kSourceDurationMs, sourceDurationMs, nullptr);
    }
    if (collapsedFlag == 1)
    {
        item.setProperty(kCollapsed, true, nullptr);
    }
    // The properties above are set on the orphan item BEFORE it joins
    // the tree so they don't generate undo actions individually — the
    // single `appendChild` below records one undoable action that
    // covers the entire item insertion (undo removes the whole child).
    library.appendChild(item, &undoManager);
    return true;
}

bool ProjectState::removeLibraryItem(const juce::String& itemId)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = library.getNumChildren() - 1; i >= 0; --i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            library.removeChild(item, &undoManager);
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemBpm(const juce::String& itemId, double bpm)
{
    return mutateDerivedLibraryItem(itemId,
                                    [bpm](juce::ValueTree& item)
                                    {
                                        if (bpm > 0.0)
                                            item.setProperty(kBpm, bpm, nullptr);
                                        else
                                            item.removeProperty(kBpm, nullptr);
                                    });
}

bool ProjectState::setLibraryItemBeats(const juce::String& itemId, const std::vector<double>& beatTimesSec)
{
    return mutateDerivedLibraryItem(itemId,
                                    [&beatTimesSec](juce::ValueTree& item)
                                    {
                                        if (beatTimesSec.empty())
                                        {
                                            item.removeProperty(kBeats, nullptr);
                                            return;
                                        }
                                        juce::Array<juce::var> arr;
                                        arr.ensureStorageAllocated(static_cast<int>(beatTimesSec.size()));
                                        for (double t : beatTimesSec) arr.add(juce::var(t));
                                        item.setProperty(kBeats, juce::var(arr), nullptr);
                                    });
}

bool ProjectState::setLibraryItemBeatAnchor(const juce::String& itemId, double anchorSec)
{
    return mutateDerivedLibraryItem(itemId,
                                    [anchorSec](juce::ValueTree& item)
                                    { item.setProperty(kBeatAnchorSec, anchorSec, nullptr); });
}

bool ProjectState::setLibraryItemPlaybackPath(const juce::String& itemId, const juce::String& playbackPath)
{
    return mutateDerivedLibraryItem(itemId,
                                    [&playbackPath](juce::ValueTree& item)
                                    {
                                        if (playbackPath.isEmpty())
                                            item.removeProperty(kPlaybackFilePath, nullptr);
                                        else
                                            item.setProperty(kPlaybackFilePath, playbackPath, nullptr);
                                    });
}

bool ProjectState::setLibraryItemFilePath(const juce::String& itemId, const juce::String& filePath)
{
    if (filePath.isEmpty()) return false;
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            item.setProperty(kFilePath, filePath, &undoManager);
            // Clear the cached playback path — the new source needs to
            // be decoded again before playback can use a WAV cache.
            item.removeProperty(kPlaybackFilePath, &undoManager);
            return true;
        }
    }
    return false;
}

juce::String ProjectState::getLibraryItemFilePath(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            return item.getProperty(kFilePath, {}).toString();
        }
    }
    return {};
}

juce::String ProjectState::getLibraryItemPlaybackPath(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            return item.getProperty(kPlaybackFilePath, {}).toString();
        }
    }
    return {};
}

bool ProjectState::setLibraryItemKey(const juce::String& itemId, const juce::String& key)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (key.isEmpty())
            {
                item.removeProperty(kKey, nullptr);
            }
            else
            {
                item.setProperty(kKey, key, nullptr);
            }
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemWarp(const juce::String& itemId,
                                      std::optional<bool> warpEnabled,
                                      std::optional<juce::String> warpMode,
                                      std::optional<double> tempoRatio,
                                      bool tempoRatioClear,
                                      std::optional<double> semitones,
                                      std::optional<double> cents)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() != itemId) continue;
        // Warp defaults are only meaningful on saved-clip items.
        if (item.getProperty(kKind).toString() != "saved-clip") return false;
        if (warpEnabled.has_value())
            item.setProperty(kWarpEnabled, *warpEnabled, &undoManager);
        if (warpMode.has_value() && warpMode->isNotEmpty())
            item.setProperty(kWarpMode, *warpMode, &undoManager);
        if (tempoRatioClear)
            item.removeProperty(kTempoRatio, &undoManager);
        else if (tempoRatio.has_value())
            item.setProperty(kTempoRatio, juce::jlimit(0.25, 4.0, *tempoRatio), &undoManager);
        if (semitones.has_value())
            item.setProperty(kSemitones, juce::jlimit(-24.0, 24.0, *semitones), &undoManager);
        if (cents.has_value())
            item.setProperty(kCents, juce::jlimit(-100.0, 100.0, *cents), &undoManager);
        return true;
    }
    return false;
}

bool ProjectState::clearLibraryItemAnalysis(const juce::String& itemId)
{
    return mutateDerivedLibraryItem(itemId,
                                    [](juce::ValueTree& item)
                                    {
                                        item.removeProperty(kBpm, nullptr);
                                        item.removeProperty(kBeats, nullptr);
                                        item.removeProperty(kBeatAnchorSec, nullptr);
                                        item.removeProperty(kVariableTempo, nullptr);
                                    });
}

juce::String ProjectState::getLibraryItemPlaybackPathForSource(const juce::String& sourceFilePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kKind, "audio-file").toString() == "audio-file"
            && item.getProperty(kFilePath).toString() == sourceFilePath)
        {
            return item.getProperty(kPlaybackFilePath, {}).toString();
        }
    }
    return {};
}

bool ProjectState::setLibraryItemVariableTempo(const juce::String& itemId, bool variable)
{
    return mutateDerivedLibraryItem(itemId,
                                    [variable](juce::ValueTree& item)
                                    {
                                        if (variable)
                                            item.setProperty(kVariableTempo, true, nullptr);
                                        else
                                            item.removeProperty(kVariableTempo, nullptr);
                                    });
}

bool ProjectState::setLibraryItemLowConfidence(const juce::String& itemId, bool lowConfidence)
{
    return mutateDerivedLibraryItem(itemId,
                                    [lowConfidence](juce::ValueTree& item)
                                    {
                                        if (lowConfidence)
                                            item.setProperty(kLowConfidence, true, nullptr);
                                        else
                                            item.removeProperty(kLowConfidence, nullptr);
                                    });
}

bool ProjectState::setLibraryItemSampleMode(const juce::String& itemId, const juce::String& mode)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (mode == "sample" || mode == "music")
            {
                item.setProperty(kSampleMode, mode, nullptr);
            }
            else
            {
                item.removeProperty(kSampleMode, nullptr);
            }
            return true;
        }
    }
    return false;
}

bool ProjectState::hasLibraryItemForPath(const juce::String& filePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kKind, "audio-file").toString() == "audio-file"
            && item.getProperty(kFilePath).toString() == filePath) return true;
    }
    return false;
}

double ProjectState::getLibraryItemBpmForPath(const juce::String& filePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return 0.0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kKind, "audio-file").toString() == "audio-file"
            && item.getProperty(kFilePath).toString() == filePath)
        {
            return static_cast<double>(item.getProperty(kBpm, 0.0));
        }
    }
    return 0.0;
}

juce::var ProjectState::libraryAsJson() const
{
    juce::Array<juce::var> arr;
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return juce::var(arr);
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (!item.hasType(kLibraryItem)) continue;
        auto* obj = new juce::DynamicObject();
        obj->setProperty("id", item.getProperty(kId).toString());
        const juce::String filePath = item.getProperty(kFilePath).toString();
        obj->setProperty("filePath", filePath);
        const auto kind = item.getProperty(kKind, "audio-file").toString();
        obj->setProperty("kind", kind);
        if (item.hasProperty(kDisplayName))
        {
            obj->setProperty("name", item.getProperty(kDisplayName).toString());
        }
        if (item.hasProperty(kName))
        {
            obj->setProperty("fileName", item.getProperty(kName).toString());
        }
        obj->setProperty("durationMs", static_cast<double>(item.getProperty(kDurationMs, 0.0)));
        obj->setProperty("sampleRate", static_cast<int>(item.getProperty(kSampleRate, 0)));
        obj->setProperty("channelCount", static_cast<int>(item.getProperty(kChannelCount, 0)));
        if (item.hasProperty(kKey))
        {
            obj->setProperty("key", item.getProperty(kKey).toString());
        }
        if (item.hasProperty(kBpm))
        {
            obj->setProperty("bpm", static_cast<double>(item.getProperty(kBpm, 0.0)));
        }
        if (item.hasProperty(kBeats))
        {
            // Pass the underlying `juce::var` array straight through —
            // it's already a `juce::var` containing `Array<var>` of
            // numbers, which `JSON::toString` serialises as `[…]`.
            obj->setProperty("beats", item.getProperty(kBeats));
        }
        if (item.hasProperty(kBeatAnchorSec))
        {
            obj->setProperty("beatAnchorSec",
                             static_cast<double>(item.getProperty(kBeatAnchorSec, 0.0)));
        }
        if (item.hasProperty(kPlaybackFilePath))
        {
            obj->setProperty("playbackFilePath", item.getProperty(kPlaybackFilePath).toString());
        }
        if (item.hasProperty(kVariableTempo) && bool(item.getProperty(kVariableTempo)))
        {
            obj->setProperty("variableTempo", true);
        }
        if (item.hasProperty(kLowConfidence) && bool(item.getProperty(kLowConfidence)))
        {
            obj->setProperty("lowConfidence", true);
        }
        if (item.hasProperty(kSampleMode))
        {
            const auto mode = item.getProperty(kSampleMode).toString();
            if (mode == "sample" || mode == "music")
            {
                obj->setProperty("sampleMode", mode);
            }
        }
        if (item.hasProperty(kSourceItemId))
        {
            obj->setProperty("sourceItemId", item.getProperty(kSourceItemId).toString());
        }
        if (item.hasProperty(kSourceClipId))
        {
            obj->setProperty("sourceClipId", item.getProperty(kSourceClipId).toString());
        }
        if (item.hasProperty(kSourceInMs))
        {
            obj->setProperty("sourceInMs", static_cast<double>(item.getProperty(kSourceInMs, 0.0)));
        }
        if (item.hasProperty(kSourceDurationMs))
        {
            obj->setProperty("sourceDurationMs", static_cast<double>(item.getProperty(kSourceDurationMs, 0.0)));
        }
        if (item.hasProperty(kCollapsed) && bool(item.getProperty(kCollapsed)))
        {
            obj->setProperty("collapsed", true);
        }
        // Saved-clip default warp settings. These travel on the library
        // item so dragging the tile back to the timeline restores the
        // user's preferred warp state for new placements; they are
        // copied-on-drop into the timeline clip and do NOT live-link
        // back here (per the linked-clip / warp design split).
        if (item.hasProperty(kWarpEnabled))
        {
            obj->setProperty("warpEnabled", static_cast<bool>(item.getProperty(kWarpEnabled, false)));
        }
        if (item.hasProperty(kWarpMode))
        {
            obj->setProperty("warpMode", item.getProperty(kWarpMode).toString());
        }
        if (item.hasProperty(kTempoRatio))
        {
            obj->setProperty("tempoRatio", static_cast<double>(item.getProperty(kTempoRatio, 1.0)));
        }
        if (item.hasProperty(kSemitones))
        {
            obj->setProperty("semitones", static_cast<double>(item.getProperty(kSemitones, 0.0)));
        }
        if (item.hasProperty(kCents))
        {
            obj->setProperty("cents", static_cast<double>(item.getProperty(kCents, 0.0)));
        }
        // Same unresolved-flag pattern as clips so the renderer can
        // grey-out library cards whose source file has gone missing
        // since the project was last saved.
        if (filePath.isEmpty() || !juce::File(filePath).existsAsFile())
        {
            obj->setProperty("unresolved", true);
        }
        arr.add(juce::var(obj));
    }
    return juce::var(arr);
}

bool ProjectState::addMarker(const juce::String& markerId, double positionMs)
{
    if (markerId.isEmpty() || positionMs < 0.0)
    {
        return false;
    }

    juce::ValueTree markers;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto child = root.getChild(i);
        if (child.hasType(kMarkers))
        {
            markers = child;
            break;
        }
    }
    if (!markers.isValid())
    {
        markers = juce::ValueTree(kMarkers);
        root.addChild(markers, -1, nullptr);
    }

    for (int i = 0; i < markers.getNumChildren(); ++i)
    {
        auto marker = markers.getChild(i);
        const double markerPositionMs = static_cast<double>(marker.getProperty(kPositionMs, 0.0));
        if (marker.hasType(kMarker) && std::abs(markerPositionMs - positionMs) < 0.5
            && marker.getProperty(kId).toString() != markerId)
        {
            return true;
        }
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            marker.setProperty(kPositionMs, positionMs, &undoManager);
            return true;
        }
    }

    juce::ValueTree marker(kMarker);
    marker.setProperty(kId, markerId, nullptr);
    marker.setProperty(kPositionMs, positionMs, nullptr);
    markers.addChild(marker, -1, &undoManager);
    return true;
}

bool ProjectState::moveMarker(const juce::String& markerId, double positionMs)
{
    if (markerId.isEmpty() || positionMs < 0.0)
    {
        return false;
    }

    auto markers = root.getChildWithName(kMarkers);
    if (!markers.isValid())
    {
        return false;
    }

    for (int i = 0; i < markers.getNumChildren(); ++i)
    {
        auto marker = markers.getChild(i);
        const double markerPositionMs = static_cast<double>(marker.getProperty(kPositionMs, 0.0));
        if (marker.hasType(kMarker) && std::abs(markerPositionMs - positionMs) < 0.5
            && marker.getProperty(kId).toString() != markerId)
        {
            return false;
        }
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            const double current = markerPositionMs;
            if (std::abs(current - positionMs) < 0.01)
            {
                return true;
            }
            marker.setProperty(kPositionMs, positionMs, &undoManager);
            return true;
        }
    }
    return false;
}

bool ProjectState::removeMarker(const juce::String& markerId)
{
    if (markerId.isEmpty())
    {
        return false;
    }

    auto markers = root.getChildWithName(kMarkers);
    if (!markers.isValid())
    {
        return false;
    }

    for (int i = markers.getNumChildren() - 1; i >= 0; --i)
    {
        auto marker = markers.getChild(i);
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            markers.removeChild(marker, &undoManager);
            return true;
        }
    }
    return false;
}

juce::var ProjectState::markersAsJson() const
{
    juce::Array<juce::var> markersArray;

    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto markers = root.getChild(i);
        if (!markers.hasType(kMarkers))
        {
            continue;
        }
        for (int m = 0; m < markers.getNumChildren(); ++m)
        {
            const auto marker = markers.getChild(m);
            if (!marker.hasType(kMarker))
            {
                continue;
            }
            auto* obj = new juce::DynamicObject();
            obj->setProperty("id", marker.getProperty(kId).toString());
            obj->setProperty("positionMs", static_cast<double>(marker.getProperty(kPositionMs, 0.0)));
            markersArray.add(juce::var(obj));
        }
    }

    return juce::var(markersArray);
}

juce::var ProjectState::tracksAsJson() const
{
    juce::Array<juce::var> tracksArray;

    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(kTrack))
        {
            continue;
        }

        auto* trackObj = new juce::DynamicObject();
        trackObj->setProperty("id", track.getProperty(kId).toString());
        trackObj->setProperty("name", track.getProperty(kName).toString());
        trackObj->setProperty("gain", static_cast<double>(track.getProperty(kGain, 1.0)));
        // Mute / solo round-trip through the project file. The
        // renderer reads them on PROJECT_STATE to seed its UI and
        // the live audio engine derives effective gain from them.
        // Both default to false and are only emitted when true to
        // keep saved files tidy.
        if (static_cast<bool>(track.getProperty(kMuted, false)))
        {
            trackObj->setProperty("muted", true);
        }
        if (static_cast<bool>(track.getProperty(kSoloed, false)))
        {
            trackObj->setProperty("soloed", true);
        }
        // Only emit heightPx when explicitly set; the renderer falls
        // back to its own default for tracks that have never been
        // resized so older projects survive without backfilling.
        if (track.hasProperty(kHeightPx))
        {
            trackObj->setProperty("heightPx", static_cast<double>(track.getProperty(kHeightPx, 0.0)));
        }

        juce::Array<juce::var> clipsArray;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(kClip))
            {
                continue;
            }
            auto* clipObj = new juce::DynamicObject();
            clipObj->setProperty("id", clip.getProperty(kId).toString());
            const juce::String libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
            clipObj->setProperty("libraryItemId", libraryItemId);
            clipObj->setProperty("offsetMs", static_cast<double>(clip.getProperty(kOffsetMs, 0.0)));
            clipObj->setProperty("inMs", static_cast<double>(clip.getProperty(kInMs, 0.0)));
            clipObj->setProperty("durationMs", static_cast<double>(clip.getProperty(kDurationMs, 0.0)));
            const auto effectiveTiming = getClipEffectiveTiming(clip.getProperty(kId).toString());
            clipObj->setProperty("effectiveTempoRatio", effectiveTiming.tempoRatio);
            clipObj->setProperty("effectiveDurationMs", effectiveTiming.durationMs);
            clipObj->setProperty("effectiveWarpActive", effectiveTiming.warpActive);
            // Only emit `colorIndex` when explicitly set so the renderer
            // can distinguish "inherit from track" (property absent)
            // from "user picked a colour".
            if (clip.hasProperty(kColorIndex))
            {
                clipObj->setProperty("colorIndex", static_cast<int>(clip.getProperty(kColorIndex, -1)));
            }
            // Lock flag: emitted only when truthy so legacy projects
            // (and explicitly-unlocked clips that removed the property)
            // round-trip without a stray `locked:false` on the wire.
            if (static_cast<bool>(clip.getProperty(kLocked, false)))
            {
                clipObj->setProperty("locked", true);
            }
            if (clip.hasProperty(kClipName))
            {
                clipObj->setProperty("name", clip.getProperty(kClipName).toString());
            }
            // Warp settings: every field is omitted when unset so older
            // projects round-trip unchanged and the renderer can default
            // each one independently.
            if (clip.hasProperty(kWarpEnabled))
            {
                clipObj->setProperty("warpEnabled", static_cast<bool>(clip.getProperty(kWarpEnabled, false)));
            }
            if (clip.hasProperty(kWarpMode))
            {
                clipObj->setProperty("warpMode", clip.getProperty(kWarpMode).toString());
            }
            if (clip.hasProperty(kTempoRatio))
            {
                clipObj->setProperty("tempoRatio", static_cast<double>(clip.getProperty(kTempoRatio, 1.0)));
            }
            if (clip.hasProperty(kSemitones))
            {
                clipObj->setProperty("semitones", static_cast<double>(clip.getProperty(kSemitones, 0.0)));
            }
            if (clip.hasProperty(kCents))
            {
                clipObj->setProperty("cents", static_cast<double>(clip.getProperty(kCents, 0.0)));
            }
            if (clip.hasProperty(kPendingAutoWarp))
            {
                clipObj->setProperty("pendingAutoWarp", static_cast<bool>(clip.getProperty(kPendingAutoWarp, false)));
            }
            // Resolve the source file through the linked library item so
            // the renderer can flag clips whose underlying file went
            // missing since the project was last saved. An empty library
            // item id (defensive — shouldn't happen) is also treated as
            // unresolved.
            const juce::String resolvedFilePath = getLibraryItemFilePath(libraryItemId);
            const bool unresolved =
                libraryItemId.isEmpty() || resolvedFilePath.isEmpty() || !juce::File(resolvedFilePath).existsAsFile();
            if (unresolved)
            {
                clipObj->setProperty("unresolved", true);
            }
            clipsArray.add(juce::var(clipObj));
        }
        trackObj->setProperty("clips", clipsArray);
        tracksArray.add(juce::var(trackObj));
    }

    return tracksArray;
}

juce::Result ProjectState::replaceTree(const juce::ValueTree& newTree)
{
    if (!newTree.isValid() || !newTree.hasType(kProject))
    {
        return juce::Result::fail("Expected root <PROJECT> element");
    }
    // Suppress dirty transitions while we wipe + re-populate `root` —
    // those listener callbacks would otherwise produce a misleading
    // "dirty=true" emission for a freshly-loaded (and therefore clean)
    // project. RAII-scoped so a thrown exception still restores the
    // listener; we explicitly markClean() at the end so the renderer
    // sees a single, correct transition.
    {
        const SuppressDirtyScope suppress(*this);
        root.removeAllChildren(nullptr);
        root.removeAllProperties(nullptr);
        root.copyPropertiesAndChildrenFrom(newTree, nullptr);
        // Ensure the standard container children exist even if the
        // loaded project file pre-dates them, so subsequent add+remove
        // cycles round-trip cleanly against the clean-snapshot baseline.
        if (!root.getChildWithName(kLibrary).isValid())
        {
            root.appendChild(juce::ValueTree(kLibrary), nullptr);
        }
        if (!root.getChildWithName(kMarkers).isValid())
        {
            root.appendChild(juce::ValueTree(kMarkers), nullptr);
        }
        undoManager.clearUndoHistory();
    }
    // A load is by definition clean (in-memory state matches disk).
    // Emit a single dirty=false transition if we were dirty going in.
    markClean();
    return juce::Result::ok();
}

} // namespace silverdaw
