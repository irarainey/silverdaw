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
        // Phase 5 — per-track Tone EQ. Persisted on the track node and
        // round-tripped to the renderer so the Track FX sliders reflect
        // the saved state after a reload (the audio engine restores tone
        // separately in rebuildEngineFromProject). Each field is emitted
        // only when non-default to keep the snapshot and saved file tidy,
        // matching the renderer's default-suppression on the way back in.
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
        if (static_cast<bool>(track.getProperty(kToneLowCut, false)))
        {
            trackObj->setProperty("toneLowCut", true);
        }
        if (static_cast<bool>(track.getProperty(kToneHighCut, false)))
        {
            trackObj->setProperty("toneHighCut", true);
        }
        // Phase 5 — per-track Leveler Amount (`[0, 1]`). Like Tone, emitted
        // only when non-default so the Track FX Leveler knob restores after a
        // reload while flat / legacy tracks stay byte-clean.
        if (track.hasProperty(kLevelerAmount))
        {
            trackObj->setProperty("levelerAmount",
                                  static_cast<double>(track.getProperty(kLevelerAmount, 0.0)));
        }
        // Phase 5 — per-track Reverb / Delay send amounts. Like Tone, these
        // live on the track node and are emitted only when non-default so
        // the Track FX Sends sliders restore after a reload while legacy
        // projects stay byte-clean. Identifiers are `sendReverb`/`sendDelay`
        // (the renderer maps them onto its `reverbSend`/`delaySend` fields).
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
        // Phase 5 — per-track equal-power pan, signed `[-1, 1]` (0 = centre).
        // Emitted only when non-default so the Track FX Pan control restores
        // after a reload while centred / legacy tracks stay byte-clean.
        if (track.hasProperty(kPan))
        {
            trackObj->setProperty("pan",
                                  static_cast<double>(track.getProperty(kPan, 0.0)));
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
            if (clip.hasProperty(kEnvelopePoints))
            {
                // Pass the stored `juce::var` ARRAY straight through — each
                // element is a `{ timeMs, gain }` object, ready for JSON and
                // matching the renderer's `ProjectStateClipSchema`. Without
                // this the per-clip Volume Shape is lost on project reload.
                clipObj->setProperty("envelopePoints", clip.getProperty(kEnvelopePoints));
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
        // §12.1 — per-track clip transitions. Emitted only when present so
        // legacy projects and transition-free tracks stay byte-clean.
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

} // namespace

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
        removeLegacyClipFadeProperties(root);
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
