#include "ProjectState.h"

namespace silverdaw
{

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
        // Emit only truthy mute/solo so defaults stay absent on disk/wire.
        if (static_cast<bool>(track.getProperty(kMuted, false)))
        {
            trackObj->setProperty("muted", true);
        }
        if (static_cast<bool>(track.getProperty(kSoloed, false)))
        {
            trackObj->setProperty("soloed", true);
        }
        // Omit unset heights so older projects need no backfill.
        if (track.hasProperty(kHeightPx))
        {
            trackObj->setProperty("heightPx", static_cast<double>(track.getProperty(kHeightPx, 0.0)));
        }
        // Persisted per-track colour; absent means the renderer's positional default.
        if (track.hasProperty(kColorIndex))
        {
            trackObj->setProperty("colorIndex", static_cast<int>(track.getProperty(kColorIndex, 0)));
        }
        // Emit only non-default Tone fields to match renderer default suppression.
        if (track.hasProperty(kToneBassDb))
        {
            trackObj->setProperty("toneBassDb",
                                  static_cast<double>(track.getProperty(kToneBassDb, 0.0)));
        }
        if (track.hasProperty(kToneMidDb))
        {
            trackObj->setProperty("toneMidDb",
                                  static_cast<double>(track.getProperty(kToneMidDb, 0.0)));
        }
        if (track.hasProperty(kToneTrebleDb))
        {
            trackObj->setProperty("toneTrebleDb",
                                  static_cast<double>(track.getProperty(kToneTrebleDb, 0.0)));
        }
        if (static_cast<double>(track.getProperty(kToneFilter, 0.0)) != 0.0)
        {
            trackObj->setProperty("toneFilter",
                                  static_cast<double>(track.getProperty(kToneFilter, 0.0)));
        }
        // Emit Leveler only when non-default so flat tracks stay byte-clean.
        if (track.hasProperty(kLevelerAmount))
        {
            trackObj->setProperty("levelerAmount",
                                  static_cast<double>(track.getProperty(kLevelerAmount, 0.0)));
        }
        // Emit sends only when non-default; renderer maps sendReverb/sendDelay names.
        if (track.hasProperty(kSendReverb))
        {
            trackObj->setProperty("sendReverb",
                                  static_cast<double>(track.getProperty(kSendReverb, 0.0)));
        }
        if (track.hasProperty(kSendDelay))
        {
            trackObj->setProperty("sendDelay",
                                  static_cast<double>(track.getProperty(kSendDelay, 0.0)));
        }
        // Emit pan only when off-centre so centred tracks stay byte-clean.
        if (track.hasProperty(kPan))
        {
            trackObj->setProperty("pan",
                                  static_cast<double>(track.getProperty(kPan, 0.0)));
        }

        // Per-track effect automation lanes (absent unless the user drew a curve).
        if (track.hasProperty(kAutomation))
        {
            trackObj->setProperty("automation", track.getProperty(kAutomation));
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
            // Absent colorIndex means inherit from track.
            if (clip.hasProperty(kColorIndex))
            {
                clipObj->setProperty("colorIndex", static_cast<int>(clip.getProperty(kColorIndex, -1)));
            }
            // Emit only locked=true so unlocked clips stay absent on the wire.
            if (static_cast<bool>(clip.getProperty(kLocked, false)))
            {
                clipObj->setProperty("locked", true);
            }
            // Emit only reversed=true so forward clips stay absent on the wire.
            if (static_cast<bool>(clip.getProperty(kReversed, false)))
            {
                clipObj->setProperty("reversed", true);
            }
            if (clip.hasProperty(kClipName))
            {
                clipObj->setProperty("name", clip.getProperty(kClipName).toString());
            }
            // Omit unset warp fields so older projects round-trip unchanged.
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
            if (clip.hasProperty(kEnvelopePoints))
            {
                // Stored envelope arrays are already renderer-schema JSON.
                clipObj->setProperty("envelopePoints", clip.getProperty(kEnvelopePoints));
            }
            // Resolve through the library item so missing sources surface as unresolved.
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
        // Omit absent transitions so transition-free tracks stay byte-clean.
        const auto transitions = buildTransitionsJson(track);
        if (auto* arr = transitions.getArray(); arr != nullptr && arr->size() > 0)
        {
            trackObj->setProperty("transitions", transitions);
        }
        tracksArray.add(juce::var(trackObj));
    }

    return tracksArray;
}

namespace
{

void removeLegacyClipFadeProperties(juce::ValueTree& tree)
{
    if (tree.hasType(juce::Identifier{"CLIP"}))
    {
        tree.removeProperty(juce::Identifier{"fadeInMs"}, nullptr);
        tree.removeProperty(juce::Identifier{"fadeOutMs"}, nullptr);
    }

    for (int i = 0; i < tree.getNumChildren(); ++i)
    {
        auto child = tree.getChild(i);
        removeLegacyClipFadeProperties(child);
    }
}

// Migrate the legacy classification property `sampleMode` (values "sample" /
// "music") to the current `audioType` (values "simple" / "music"). The word
// "sample" now means a saved-from-clip file kind, so the classification value
// "sample" became "simple". Runs on load so old projects open unchanged.
void migrateLegacyAudioType(juce::ValueTree& tree)
{
    static const juce::Identifier legacy{"sampleMode"};
    static const juce::Identifier current{"audioType"};
    if (tree.hasProperty(legacy))
    {
        const auto legacyValue = tree.getProperty(legacy).toString();
        if (!tree.hasProperty(current))
        {
            const juce::String migrated = legacyValue == "sample" ? juce::String("simple") : legacyValue;
            if (migrated == "simple" || migrated == "music")
            {
                tree.setProperty(current, migrated, nullptr);
            }
        }
        tree.removeProperty(legacy, nullptr);
    }

    for (int i = 0; i < tree.getNumChildren(); ++i)
    {
        auto child = tree.getChild(i);
        migrateLegacyAudioType(child);
    }
}

// Migrate legacy library-item `kind` values to the current vocabulary. The old
// scheme used "audio-file" for both imported sources and saved-from-clip files
// (distinguished only by a `sourceItemId` link) and "saved-clip" for reusable
// clips. The current scheme makes these explicit: "source", "sample" and "clip".
// Runs on load so old projects open unchanged.
void migrateLegacyLibraryKind(juce::ValueTree& tree)
{
    static const juce::Identifier kindId{"kind"};
    static const juce::Identifier sourceItemIdId{"sourceItemId"};
    if (tree.hasType(juce::Identifier{"ITEM"}))
    {
        const auto kind = tree.getProperty(kindId).toString();
        if (kind == "audio-file" || kind.isEmpty())
        {
            const bool hasSourceLink = tree.getProperty(sourceItemIdId).toString().isNotEmpty();
            tree.setProperty(kindId, hasSourceLink ? juce::String("sample") : juce::String("source"), nullptr);
        }
        else if (kind == "saved-clip")
        {
            tree.setProperty(kindId, juce::String("clip"), nullptr);
        }
    }

    for (int i = 0; i < tree.getNumChildren(); ++i)
    {
        auto child = tree.getChild(i);
        migrateLegacyLibraryKind(child);
    }
}

} // namespace

juce::Result ProjectState::replaceTree(const juce::ValueTree& newTree)
{
    if (!newTree.isValid() || !newTree.hasType(kProject))
    {
        return juce::Result::fail("Expected root <PROJECT> element");
    }
    // Suppress listener dirties during load; markClean emits the final correct state.
    {
        const SuppressDirtyScope suppress(*this);
        root.removeAllChildren(nullptr);
        root.removeAllProperties(nullptr);
        root.copyPropertiesAndChildrenFrom(newTree, nullptr);
        removeLegacyClipFadeProperties(root);
        migrateLegacyAudioType(root);
        migrateLegacyLibraryKind(root);
        // Backfill a stable per-track colour for legacy projects so inherited
        // clip colours stop shifting with track order across reloads. The ordinal
        // mirrors the renderer's positional fallback, so the first load is
        // visually unchanged; persisting it freezes the colour from then on.
        int trackOrdinal = 0;
        for (int i = 0; i < root.getNumChildren(); ++i)
        {
            auto child = root.getChild(i);
            if (!child.hasType(kTrack))
            {
                continue;
            }
            if (!child.hasProperty(kColorIndex))
            {
                child.setProperty(kColorIndex, trackOrdinal, nullptr);
            }
            ++trackOrdinal;
        }
        // Backfill standard containers so add/remove cycles can return to clean.
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
    // A load is clean because in-memory state now matches disk.
    markClean();
    return juce::Result::ok();
}

} // namespace silverdaw
