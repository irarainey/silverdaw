#include "ProjectState.h"

#include <cmath>

namespace silverdaw
{

juce::String ProjectState::getName() const
{
    const auto stored = root.getProperty(kName, kDefaultName).toString().trim();
    return stored.isEmpty() ? kDefaultName : stored;
}

void ProjectState::setName(const juce::String& name)
{
    const auto trimmed = name.trim();
    // Renaming is a project-identity edit, not a content edit: it marks the
    // project dirty (via the ValueTree listener) but must stay off the undo
    // stack so Ctrl+Z after a rename never reverts the name.
    root.setProperty(kName, trimmed.isEmpty() ? kDefaultName : trimmed, nullptr);
}

double ProjectState::getViewPxPerSecond() const
{
    // Match renderer default zoom for projects saved before this preference.
    return static_cast<double>(root.getProperty(kViewPxPerSecond, 100.0));
}

void ProjectState::setViewPxPerSecond(double pxPerSecond)
{
    // Clamp to the renderer's supported zoom range so a stale or malformed
    // payload can't persist an out-of-range view. Mirror into cleanSnapshot
    // so it never marks dirty.
    const double clamped = juce::jlimit(10.0, 800.0, pxPerSecond);
    setNonDirtyRootProperty(kViewPxPerSecond, clamped);
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

bool ProjectState::isBpmSeeded() const
{
    return static_cast<bool>(root.getProperty(kBpmSeeded, false));
}

void ProjectState::setBpmSeeded(bool seeded)
{
    // Seeding state tracks derived tempo provenance, not a user edit.
    setNonDirtyRootProperty(kBpmSeeded, seeded);
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

int ProjectState::getBarCounterStart() const
{
    return static_cast<int>(root.getProperty(kBarCounterStart, 1));
}

void ProjectState::setBarCounterStart(int barCounterStart)
{
    // Default one is suppressed so legacy projects round-trip without an extra property.
    if (barCounterStart == 1)
    {
        root.removeProperty(kBarCounterStart, &undoManager);
    }
    else
    {
        root.setProperty(kBarCounterStart, barCounterStart, &undoManager);
    }
}

int ProjectState::getMixdownStartBar() const
{
    return static_cast<int>(root.getProperty(kMixdownStartBar, 1));
}

void ProjectState::setMixdownStartBar(int mixdownStartBar)
{
    // Default one is suppressed so legacy projects round-trip without an extra property.
    if (mixdownStartBar == 1)
    {
        root.removeProperty(kMixdownStartBar, &undoManager);
    }
    else
    {
        root.setProperty(kMixdownStartBar, mixdownStartBar, &undoManager);
    }
}

bool ProjectState::getMetronomeEnabled() const
{
    return static_cast<bool>(root.getProperty(kMetronomeEnabled, false));
}

void ProjectState::setMetronomeEnabled(bool enabled)
{
    // A monitoring aid, not a content edit: persisted but silent (never dirty, never undoable).
    // Default-off removes the property so projects round-trip without an extra field. Mirror both
    // root and cleanSnapshot under a suppress scope so the toggle never produces a phantom dirty.
    const SuppressDirtyScope suppress(*this);
    if (! enabled)
    {
        root.removeProperty(kMetronomeEnabled, nullptr);
        if (cleanSnapshot.isValid()) cleanSnapshot.removeProperty(kMetronomeEnabled, nullptr);
    }
    else
    {
        root.setProperty(kMetronomeEnabled, true, nullptr);
        if (cleanSnapshot.isValid()) cleanSnapshot.setProperty(kMetronomeEnabled, true, nullptr);
    }
}

bool ProjectState::getClipEditorMetronomeEnabled() const
{
    return static_cast<bool>(root.getProperty(kClipEditorMetronomeEnabled, false));
}

void ProjectState::setClipEditorMetronomeEnabled(bool enabled)
{
    // Independent of the main metronome, same silent semantics (never dirty, never undoable;
    // default-off stored as absent).
    const SuppressDirtyScope suppress(*this);
    if (! enabled)
    {
        root.removeProperty(kClipEditorMetronomeEnabled, nullptr);
        if (cleanSnapshot.isValid()) cleanSnapshot.removeProperty(kClipEditorMetronomeEnabled, nullptr);
    }
    else
    {
        root.setProperty(kClipEditorMetronomeEnabled, true, nullptr);
        if (cleanSnapshot.isValid()) cleanSnapshot.setProperty(kClipEditorMetronomeEnabled, true, nullptr);
    }
}

} // namespace silverdaw
