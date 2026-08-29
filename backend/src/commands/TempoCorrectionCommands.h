#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

/**
 * Correct a mis-detected tempo (ADR 0027).
 *
 * A correction is a distinct operation from a tempo *change*, and the line between them
 * is drawn at persisted position: this handler never moves a clip start, a marker, an
 * automation point, the timeline selection or the playhead. It therefore makes none of
 * the `retime*ForTempoChange` calls that `handleProjectSetBpm` exists to make.
 *
 * Tempo-derived and clip-local geometry does move — every clip following the corrected
 * tempo re-derives its ratio and therefore its length, and clip volume shapes scale with
 * that footprint — and all of it is reconciled from the final corrected state before a
 * single `TEMPO_CORRECTION_APPLIED` is broadcast.
 *
 * One command rather than two messages in an undo group: an edit group gives one undo
 * press but is transaction coalescing, not atomic validation, so the source half could
 * land while the project half was rejected and leave the project half-corrected.
 *
 * Runs on the message thread.
 */
void handleLibraryItemCorrectTempo(const juce::var& payload, AudioEngine& engine,
                                   ProjectState& projectState, BridgeServer& bridge);

} // namespace silverdaw
