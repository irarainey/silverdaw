#pragma once

// Standalone DTO structs used by ProjectState's public API. Extracted to keep
// ProjectState.h focused on method declarations and under the ADR 0016 ceiling.

#include <juce_core/juce_core.h>

#include "EdgeFadeSnapshot.h"

namespace silverdaw
{

struct BeatRepeatRegion
{
    juce::String id;
    double startBeat{0.0};
    double lengthBeats{4.0};
    juce::String division{"1/8"};
};

// Per-warp-clip snapshot returned by `ProjectState::forEachWarpClip`.
struct WarpClipInfo
{
    juce::String clipId;
    juce::String libraryItemId;
    bool warpEnabled;
    bool tempoRatioPinned;
    double tempoRatio;
    double semitones;
    double cents;
    juce::String warpMode;
    // Distinguishes pending auto-warp from explicit warp-off before BPM was known.
    bool pendingAutoWarp;
};

// Effective timeline timing for a clip (may differ from stored duration when warped).
struct EffectiveClipTiming
{
    double tempoRatio = 1.0;
    double durationMs = 0.0;
    bool warpActive = false;
};

/**
 * Drift small enough to treat a warp as doing nothing: under a millisecond across the
 * whole clip, well inside a single audio buffer.
 *
 * A ratio threshold cannot answer this question, because the same ratio moves a
 * three-minute stem a hundred times further than a two-bar loop. Mirrored by the
 * renderer's `WARP_NEGLIGIBLE_DRIFT_MS`, and the two must stay in step (ADR 0024).
 */
inline constexpr double kWarpNegligibleDriftMs = 1.0;

// Immutable message-thread snapshot for preparing clip audio off-thread.
struct ClipPreparationInfo
{
    juce::String clipId;
    juce::String libraryItemId;
    juce::String sourcePath;
    double inMs = 0.0;
    double durationMs = 0.0;
    bool reversed = false;
    bool warpEnabled = false;
    juce::String warpMode{"rhythmic"};
    double tempoRatio = 1.0;
    double semitones = 0.0;
    double cents = 0.0;
};

// Derived edge fades ready for AudioEngine::setClipEdgeFade.
struct ClipEdgeFade
{
    bool hasFadeIn = false;
    double fadeInStartMs = 0.0;
    double fadeInEndMs = 0.0;
    EdgeFadeCurve fadeInCurve = EdgeFadeCurve::equalPower;
    bool hasFadeOut = false;
    double fadeOutStartMs = 0.0;
    double fadeOutEndMs = 0.0;
    EdgeFadeCurve fadeOutCurve = EdgeFadeCurve::equalPower;
    bool any() const noexcept { return hasFadeIn || hasFadeOut; }
};

} // namespace silverdaw
