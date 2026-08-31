#pragma once

// Standalone DTO structs used by ProjectState's public API. Extracted to keep
// ProjectState.h focused on method declarations and under the ADR 0016 ceiling.

#include <juce_core/juce_core.h>

#include <cmath>

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

// One VST3 insert on a track, in chain order (ADR 0025). `state` is the plugin's own opaque
// chunk, base64-encoded so it stays inline in the single-file project.
struct TrackPluginSlot
{
    juce::String slotId;
    juce::String identifier;
    juce::String formatName{"VST3"};
    juce::String name;
    juce::String manufacturer;
    bool bypassed{false};
    juce::String state;
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
    // Native (unwarped) length, so callers can judge whether a warp would do anything
    // without a second lookup. Zero when the audio has not landed yet.
    double durationMs;
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

/**
 * True when warping `durationMs` of audio at `ratio` moves the clip's end audibly.
 *
 * The one place this test lives, so every caller that has to decide whether a warp is
 * worth having — enabling one, drawing one, reporting one — reaches the same answer.
 * Mirrors the renderer's `warpChangesTiming` (ADR 0024).
 *
 * A clip whose length is not known yet falls back to the ratio, matching "can't tell,
 * so treat it as warped" rather than reporting a stretch as doing nothing.
 */
inline bool warpChangesTiming(double durationMs, double ratio)
{
    if (ratio <= 0.0) return false;
    if (durationMs <= 0.0) return std::abs(ratio - 1.0) > 1.0e-9;
    return std::abs(durationMs / ratio - durationMs) >= kWarpNegligibleDriftMs;
}

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
