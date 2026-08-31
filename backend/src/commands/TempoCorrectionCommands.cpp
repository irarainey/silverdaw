#include "TempoCorrectionCommands.h"

#include <cmath>

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "ProjectState.h"

namespace silverdaw
{
namespace
{
// The tempo box accepts the same range, so a correction cannot reach a value the user
// could not have typed there. Anything outside it is a mistyped digit rather than a
// tempo, and applying it would re-warp the whole project by an order of magnitude.
constexpr double kMinBpm = 20.0;
constexpr double kMaxBpm = 300.0;

void broadcastFailure(BridgeServer& bridge, const juce::String& itemId, const juce::String& error)
{
    log::warn("tempo", "LIBRARY_ITEM_CORRECT_TEMPO rejected itemId=" + itemId + ": " + error);
    auto* p = new juce::DynamicObject();
    p->setProperty("ok", false);
    p->setProperty("itemId", itemId);
    p->setProperty("error", error);
    bridge.broadcast("TEMPO_CORRECTION_APPLIED", juce::var(p));
}

juce::String reasonToString(ProjectState::TempoReason reason)
{
    switch (reason)
    {
        case ProjectState::TempoReason::musicalLength: return "musicalLength";
        case ProjectState::TempoReason::ownBpm: return "ownBpm";
        case ProjectState::TempoReason::inheritedBpm: return "inheritedBpm";
        case ProjectState::TempoReason::oneShot:
        case ProjectState::TempoReason::none:
        default: return "none";
    }
}
} // namespace

void handleLibraryItemCorrectTempo(const juce::var& payload, AudioEngine& engine,
                                   ProjectState& projectState, BridgeServer& bridge)
{
    const juce::String itemId = payload.getProperty("itemId", juce::var()).toString();
    if (itemId.isEmpty())
    {
        broadcastFailure(bridge, itemId, "No track was selected.");
        return;
    }

    const auto bpmVar = payload.getProperty("bpm", juce::var());
    if (!(bpmVar.isDouble() || bpmVar.isInt() || bpmVar.isInt64()))
    {
        broadcastFailure(bridge, itemId, "That tempo is not a number.");
        return;
    }
    const double bpm = static_cast<double>(bpmVar);
    // isfinite() first, and deliberately: a NaN compares false against every bound, so
    // range checks alone would wave it through and write a tempo nothing can divide by.
    if (!std::isfinite(bpm) || bpm < kMinBpm || bpm > kMaxBpm)
    {
        broadcastFailure(bridge, itemId,
                         "The tempo must be between " + juce::String(static_cast<int>(kMinBpm))
                             + " and " + juce::String(static_cast<int>(kMaxBpm)) + " BPM.");
        return;
    }

    // The correction is written to the item that OWNS the tempo, not the one the user
    // happened to have open. Correcting a stem or a saved clip in place would split it
    // away from its parent and leave every sibling on the wrong number (ADR 0027).
    const auto owner = projectState.resolveTempoOwner(itemId);
    if (owner.reason == ProjectState::TempoReason::oneShot)
    {
        broadcastFailure(bridge, itemId,
                         "This is a one-shot, so it has no tempo to correct. Classify it as music first.");
        return;
    }
    if (owner.reason == ProjectState::TempoReason::none || owner.ownerItemId.isEmpty())
    {
        broadcastFailure(bridge, itemId,
                         "No tempo has been detected for this track yet, so there is nothing to correct.");
        return;
    }

    const double previousBpm = owner.bpm;
    const bool musicalLengthDiscarded =
        owner.reason == ProjectState::TempoReason::musicalLength
        || projectState.getLibraryItemMusicalBeats(owner.ownerItemId) > 0;

    // The anchor is resolved AFTER the owner, because it is written to the owner and not
    // to the item the caller named. Omitting it therefore has to mean "leave the owner's
    // phase alone": defaulting to 0 would snap an ancestor's grid to the start of its
    // file and slide the grid of every clip ever cut from it, while the user believes
    // they only corrected a number. A value that is not a usable time is a mistake worth
    // reporting rather than rounding away.
    double beatAnchorSec = projectState.getLibraryItemBeatAnchorSec(owner.ownerItemId);
    if (payload.hasProperty("beatAnchorSec"))
    {
        const auto anchorVar = payload.getProperty("beatAnchorSec", juce::var());
        if (!(anchorVar.isDouble() || anchorVar.isInt() || anchorVar.isInt64()))
        {
            broadcastFailure(bridge, itemId, "That beat position is not a number.");
            return;
        }
        const double requested = static_cast<double>(anchorVar);
        if (!std::isfinite(requested) || requested < 0.0)
        {
            broadcastFailure(bridge, itemId, "That beat position is not a valid time.");
            return;
        }
        beatAnchorSec = requested;
    }

    // Captured before anything moves. Volume shapes are clip-local milliseconds measured
    // across a footprint, so the retime below can only know how far each clip actually
    // re-stretched by comparing against the footprints the shapes were drawn against.
    const auto previousFootprints = projectState.snapshotClipFootprints();
    const int transitionsBefore = projectState.countTransitions();

    // Writes the corrected tempo onto the owner, rebuilds its beat grid, broadcasts
    // LIBRARY_ITEM_ANALYSIS, and re-derives every clip that follows the owner's tempo
    // against the project tempo, which this command never touches.
    //
    // Deliberately none of the `retime*ForTempoChange` calls that `handleProjectSetBpm`
    // makes: this is the whole difference between correcting a tempo and changing one. A
    // clip start, a marker, an automation point, the timeline selection and the playhead
    // all stay exactly where the user put them.
    //
    // Seeding is suppressed for the same reason. Setting the project tempo from the first
    // clip dropped is merely a convenience, with no linkage and no history: nothing
    // records that it happened and the item may since have left the project. The number
    // is therefore the user's, not the file's, and moving it as a side effect of a source
    // correction is exactly the inference ADR 0027 forbids.
    const auto rederive = applyManualTempo(owner.ownerItemId, bpm, beatAnchorSec, engine,
                                           projectState, bridge,
                                           /*allowProjectBpmSeeding=*/false);

    // Last, so it measures the footprints the re-derive has settled on. A volume shape
    // has to follow its clip's footprint rather than the tempo: a pinned ratio or a clip
    // left unwarped does not re-stretch, and its shape must stay put.
    const int envelopesRetimed = projectState.retimeClipEnvelopesForFootprintChange(
        previousFootprints,
        [&](const juce::String& clipId, const juce::Array<juce::var>& points)
        { engine.setClipEnvelope(clipId, points); });

    // Reconciled here, not left to the dispatcher, so the count in the report is true of
    // the state the user is about to be told about. The dispatcher's later pass compares
    // against the count from before this command ran, so these removals are still synced
    // to the engine and published to the renderer.
    int transitionsRemoved = 0;
    if (transitionsBefore > 0)
    {
        projectState.reconcileTransitions(/*useUndo=*/true);
        transitionsRemoved = transitionsBefore - projectState.countTransitions();
    }

    const int clipsPastProjectLength =
        projectState.countClipsEndingAfter(projectState.getProjectLengthMs());

    log::info("tempo",
              "corrected itemId=" + itemId + " owner=" + owner.ownerItemId + " ("
                  + reasonToString(owner.reason) + ") " + juce::String(previousBpm, 2) + " -> "
                  + juce::String(bpm, 2) + " clips=" + juce::String(rederive.clipsUpdated)
                  + " pinned=" + juce::String(rederive.clipsPinnedExcluded) + " unwarped="
                  + juce::String(rederive.clipsUnwarpedExcluded) + " envelopes="
                  + juce::String(envelopesRetimed) + " transitionsRemoved="
                  + juce::String(transitionsRemoved) + " pastLength="
                  + juce::String(clipsPastProjectLength));

    auto* p = new juce::DynamicObject();
    p->setProperty("ok", true);
    p->setProperty("itemId", itemId);
    p->setProperty("ownerItemId", owner.ownerItemId);
    p->setProperty("ownerReason", reasonToString(owner.reason));
    p->setProperty("appliedBpm", bpm);
    p->setProperty("previousBpm", previousBpm);
    p->setProperty("musicalLengthDiscarded", musicalLengthDiscarded);
    p->setProperty("clipsUpdated", rederive.clipsUpdated);
    p->setProperty("clipsPinnedExcluded", rederive.clipsPinnedExcluded);
    p->setProperty("clipsUnwarpedExcluded", rederive.clipsUnwarpedExcluded);
    p->setProperty("transitionsRemoved", transitionsRemoved);
    p->setProperty("clipsPastProjectLength", clipsPastProjectLength);
    bridge.broadcast("TEMPO_CORRECTION_APPLIED", juce::var(p));
}

} // namespace silverdaw
