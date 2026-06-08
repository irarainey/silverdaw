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
    // Initialise before listener attach so defaults don't count as user edits.
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
    // Snapshot the new baseline so later net-zero edits can return to clean.
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
    // Equivalence against the clean snapshot lets net-zero edits clear dirty.
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
    // Mirror into cleanSnapshot so non-edit state cannot create phantom dirty deltas.
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

    // Suppress both live and mirror writes because descendant listeners mark dirty.
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
    // Match renderer default zoom for projects saved before this preference.
    return static_cast<double>(root.getProperty(kViewPxPerSecond, 100.0));
}

void ProjectState::setViewPxPerSecond(double pxPerSecond)
{
    // Mirror zoom into cleanSnapshot so it never marks dirty.
    setNonDirtyRootProperty(kViewPxPerSecond, pxPerSecond);
}

double ProjectState::getViewScrollX() const
{
    return static_cast<double>(root.getProperty(kViewScrollX, 0.0));
}

void ProjectState::setViewScrollX(double scrollX)
{
    // Mirror scroll into cleanSnapshot so it never marks dirty.
    setNonDirtyRootProperty(kViewScrollX, scrollX);
}

juce::String ProjectState::getViewSelectedTrack() const
{
    return root.getProperty(kViewSelectedTrack, juce::String{}).toString();
}

void ProjectState::setViewSelectedTrack(const juce::String& trackId)
{
    // Selection is navigation, not a content edit.
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
    // Mirror playhead into cleanSnapshot so transport movement cannot cause phantom dirty.
    setNonDirtyRootProperty(kPlayheadMs, playheadMs);
}

double ProjectState::getBpm() const
{
    return static_cast<double>(root.getProperty(kBpm, 100.0));
}

void ProjectState::setBpm(double bpm)
{
    // Tempo edits belong in undo.
    root.setProperty(kBpm, bpm, &undoManager);
}

double ProjectState::getProjectLengthMs() const
{
    return static_cast<double>(root.getProperty(kProjectLengthMs, 0.0));
}

void ProjectState::setProjectLengthMs(double lengthMs)
{
    // User-chosen length edits belong in undo.
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
    // Empty strings are persisted as absent properties.
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
    // Empty target sample rate is persisted as an absent property.
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
    // Export prefs skip undo but still mark dirty through the listener.
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
    // Unity is absent so legacy projects round-trip clean.
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
