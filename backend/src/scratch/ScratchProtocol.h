#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include <cstdint>
#include <optional>
#include <vector>

namespace silverdaw::scratch
{

inline constexpr int kProtocolVersion = 1;
inline constexpr int kPatternVersion = 1;
inline constexpr int kMaxPatternPoints = 100000;
inline constexpr double kMaxAbsoluteTurns = 1000000.0;
inline constexpr double kMaxEventDeltaTurns = 8.0;
inline constexpr const char* kCrossfaderCurveVersion = "linear-v1";

enum class DeckSide
{
    deck1 = 1,
    deck2 = 2
};

enum class ControlAction
{
    play,
    pause,
    recordArm,
    recordDisarm,
    recordStart,
    recordStop,
    seek,
    platterMove,
    platterTouch,
    crossfader,
    backingGain,
    scratchGain,
    backingLoop
};

struct SessionOpenPayload
{
    juce::String clipId;
    // When set, the scratch source is prepared from a library item's full audio
    // instead of a timeline clip. Exactly one of clipId / libraryItemId is set;
    // the non-empty one is the session identity echoed in state.
    juce::String libraryItemId;
};

struct SessionClosePayload
{
    juce::String sessionId;
};

// Backing accompaniment bed (ADR 0021, Amendment 1). Track-filtered window the
// backend renders offline; startAnchor is "arrangement" (project origin) or
// "playhead" (current transport position).
struct BackingPreparePayload
{
    juce::String sessionId;
    std::vector<juce::String> trackIds;
    juce::String startAnchor;
    int durationSec = 60;
};

struct BackingClearPayload
{
    juce::String sessionId;
};

struct SessionControlPayload
{
    juce::String sessionId;
    ControlAction action = ControlAction::pause;
    std::optional<DeckSide> deck;
    std::int64_t positionUs = 0;
    double deltaTurns = 0.0;
    double crossfader = 0.0;
    // Monitor-only trim (0..1) for backingGain / scratchGain actions; never recorded.
    double gain = 1.0;
    bool touched = false;
    // Whether the backing bed auto-restarts at its end (backingLoop action).
    bool loop = false;
};

struct PlatterKeyframe
{
    std::int64_t timeUs = 0;
    double turns = 0.0;
    bool touched = false;
};

struct CrossfaderKeyframe
{
    std::int64_t timeUs = 0;
    double value = 0.0;
};

struct PatternProvenance
{
    juce::String sourceClipId;
    std::optional<juce::String> sourceLibraryItemId;
};

struct Pattern
{
    juce::String id;
    juce::String name;
    std::int64_t durationUs = 0;
    std::int64_t cropStartUs = 0;
    std::int64_t cropEndUs = 0;
    double sourceOffsetTurns = 0.0;
    DeckSide ownerDeck = DeckSide::deck1;
    std::vector<PlatterKeyframe> platter;
    std::vector<CrossfaderKeyframe> crossfader;
    std::optional<PatternProvenance> provenance;
};

// Returns true when the payload's "protocolVersion" field is a finite number
// equal to kProtocolVersion. Command handlers should call this once and reject
// early rather than duplicating the numeric type/value check inline.
bool hasValidProtocolVersion(const juce::var& payload);

std::optional<SessionOpenPayload> parseSessionOpenPayload(const juce::var& payload);
std::optional<SessionClosePayload> parseSessionClosePayload(const juce::var& payload);
std::optional<BackingPreparePayload> parseBackingPreparePayload(const juce::var& payload);
std::optional<BackingClearPayload> parseBackingClearPayload(const juce::var& payload);
std::optional<SessionControlPayload> parseSessionControlPayload(const juce::var& payload);
std::optional<Pattern> parsePattern(const juce::var& value);
juce::var serializePattern(const Pattern& pattern);

} // namespace silverdaw::scratch
