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
const juce::Identifier ProjectState::kViewSelectedTrack{"viewSelectedTrack"};
const juce::Identifier ProjectState::kViewFxPanelOpen{"viewFxPanelOpen"};
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
const juce::Identifier ProjectState::kPan{"pan"};
const juce::Identifier ProjectState::kToneBassDb{"toneBassDb"};
const juce::Identifier ProjectState::kToneMidDb{"toneMidDb"};
const juce::Identifier ProjectState::kToneTrebleDb{"toneTrebleDb"};
const juce::Identifier ProjectState::kToneLowCut{"toneLowCut"};
const juce::Identifier ProjectState::kToneHighCut{"toneHighCut"};
const juce::Identifier ProjectState::kLevelerAmount{"levelerAmount"};
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

juce::String ProjectState::getViewSelectedTrack() const
{
    return root.getProperty(kViewSelectedTrack, juce::String{}).toString();
}

void ProjectState::setViewSelectedTrack(const juce::String& trackId)
{
    // Selection is navigation, not a content edit — view state, never
    // marks dirty (mirrors scroll/zoom).
    setNonDirtyRootProperty(kViewSelectedTrack, trackId);
}

bool ProjectState::getViewFxPanelOpen() const
{
    return static_cast<bool>(root.getProperty(kViewFxPanelOpen, false));
}

void ProjectState::setViewFxPanelOpen(bool open)
{
    setNonDirtyRootProperty(kViewFxPanelOpen, open);
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

} // namespace silverdaw
