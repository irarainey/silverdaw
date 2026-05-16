#include "ProjectState.h"

namespace silverdaw
{

const juce::Identifier ProjectState::kProject{"PROJECT"};
const juce::Identifier ProjectState::kTrack{"TRACK"};
const juce::Identifier ProjectState::kClip{"CLIP"};
const juce::Identifier ProjectState::kId{"id"};
const juce::Identifier ProjectState::kGain{"gain"};
const juce::Identifier ProjectState::kFilePath{"filePath"};
const juce::Identifier ProjectState::kOffsetMs{"offsetMs"};
const juce::Identifier ProjectState::kDurationMs{"durationMs"};

ProjectState::ProjectState() : root(kProject) {}

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

float ProjectState::getTrackGain(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 1.0F;
    }
    return static_cast<float>(static_cast<double>(track.getProperty(kGain, 1.0)));
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
// bridge envelope itself uses three distinct string fields. The parameter
// order is a load-bearing wire-protocol convention; swapping is silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
bool ProjectState::addClip(const juce::String& trackId, const juce::String& clipId, const juce::String& filePath,
                           double offsetMs, double durationMs)
{
    if (trackId.isEmpty() || clipId.isEmpty())
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
    clip.setProperty(kFilePath, filePath, &undoManager);
    clip.setProperty(kOffsetMs, offsetMs, &undoManager);
    clip.setProperty(kDurationMs, durationMs, &undoManager);
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
    return clip.getProperty(kFilePath).toString();
}

juce::var ProjectState::toJson() const
{
    auto* tracksArrayObj = new juce::DynamicObject();
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
        trackObj->setProperty("gain", static_cast<double>(track.getProperty(kGain, 1.0)));

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
            clipObj->setProperty("filePath", clip.getProperty(kFilePath).toString());
            clipObj->setProperty("offsetMs", static_cast<double>(clip.getProperty(kOffsetMs, 0.0)));
            clipObj->setProperty("durationMs", static_cast<double>(clip.getProperty(kDurationMs, 0.0)));
            clipsArray.add(juce::var(clipObj));
        }
        trackObj->setProperty("clips", clipsArray);
        tracksArray.add(juce::var(trackObj));
    }

    tracksArrayObj->setProperty("tracks", tracksArray);
    return {tracksArrayObj};
}

} // namespace silverdaw
