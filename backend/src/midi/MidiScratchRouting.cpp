#include "MidiScratchRouting.h"

#include "AudioEngine.h"
#include "ScratchSessionCommands.h"

namespace silverdaw
{

void MidiScratchRouter::setEngine(AudioEngine& engine)
{
    scratchEngine = &engine;
}

void MidiScratchRouter::setSetting(const juce::String& identifier, bool reverseCrossfader)
{
    crossfaderDirections[identifier] = reverseCrossfader;
}

bool MidiScratchRouter::lookupReverseCrossfader(const juce::String& identifier) const
{
    const auto it = crossfaderDirections.find(identifier);
    return it != crossfaderDirections.end() && it->second;
}

void MidiScratchRouter::releaseAllOwners(const juce::String& identifier)
{
    if (scratchEngine == nullptr)
        return;
    scratchEngine->releaseScratchMidiOwner(identifier);
}

void MidiScratchRouter::releaseDeckOwner(const juce::String& identifier,
                                          scratch::DeckSide deck)
{
    if (scratchEngine == nullptr)
        return;
    scratchEngine->releaseScratchMidiOwner(identifier, deck);
}

void MidiScratchRouter::routeImmediate(const juce::String& identifier,
                                        MidiScratchDeviceState& state,
                                        juce::int64 timestampMs,
                                        const MidiControllerEvent& event,
                                        BridgeServer* bridge)
{
    if (scratchEngine == nullptr)
        return;
    bool applied = false;
    bool broadcastImmediately = true;
    if (event.action == MidiControllerAction::playPause
        && event.kind == MidiControllerValueKind::button
        && event.value > 0.5 && event.deck >= 1 && event.deck <= 2)
    {
        applied = scratchEngine->scratchMidiTogglePlay(
            identifier, static_cast<scratch::DeckSide>(event.deck));
    }
    else if (event.action == MidiControllerAction::jogTouch
             && event.kind == MidiControllerValueKind::button
             && event.deck >= 1 && event.deck <= 2)
    {
        const auto deckIndex = static_cast<std::size_t>(event.deck - 1);
        const auto touched = event.value > 0.5;
        state.touchPressed[deckIndex] = touched;
        state.movementReleaseDeadlineMs[deckIndex] = 0;
        applied = scratchEngine->scratchMidiSetTouch(
            identifier, static_cast<scratch::DeckSide>(event.deck), touched);
    }
    else if (event.action == MidiControllerAction::crossfader
             && event.kind == MidiControllerValueKind::absolute)
    {
        const auto directedValue = state.reverseCrossfader ? 1.0 - event.value : event.value;
        applied = scratchEngine->scratchMidiSetCrossfader(
            identifier, directedValue, event.value);
        // High-resolution faders can emit hundreds of values per second. The
        // audio target follows each one; the 30 Hz state emitter updates the UI.
        broadcastImmediately = false;
    }
    if (applied && broadcastImmediately && bridge != nullptr)
        broadcastScratchSessionState(*scratchEngine, *bridge);
    juce::ignoreUnused(timestampMs);
}

void MidiScratchRouter::routeRelative(const juce::String& identifier,
                                       MidiScratchDeviceState& state,
                                       juce::int64 timestampMs,
                                       const MidiControllerEvent& event) const
{
    if (scratchEngine == nullptr || event.deck < 1 || event.deck > 2
        || event.value == 0.0)
        return;
    const auto deckIndex = static_cast<std::size_t>(event.deck - 1);
    const bool isPlatterMovement =
        event.action == MidiControllerAction::jogScratch
        || event.action == MidiControllerAction::jogPitchBend
        || event.action == MidiControllerAction::jogSearch
        || event.action == MidiControllerAction::wheelPitchBend
        || event.action == MidiControllerAction::wheelSearch;
    if (!isPlatterMovement)
        return;
    // Convert raw relative ticks to calibrated platter turns.
    const auto ticksPerTurn = juce::jmax(1, state.scratchTicksPerTurn);
    const auto deltaTurns = event.value / static_cast<double>(ticksPerTurn);
    if (scratchEngine->scratchMidiMovePlatter(
            identifier,
            static_cast<scratch::DeckSide>(event.deck),
            deltaTurns,
            static_cast<double>(timestampMs))
        && !state.touchPressed[deckIndex])
    {
        state.movementReleaseDeadlineMs[deckIndex] = timestampMs + 120;
    }
}

void MidiScratchRouter::checkExpiredOwners(const juce::String& identifier,
                                            MidiScratchDeviceState& state,
                                            juce::int64 nowMs,
                                            BridgeServer* bridge)
{
    if (scratchEngine == nullptr)
        return;
    for (int deckIndex = 0; deckIndex < 2; ++deckIndex)
    {
        auto& deadline = state.movementReleaseDeadlineMs[deckIndex];
        if (deadline <= 0 || nowMs < deadline)
            continue;
        deadline = 0;
        scratchEngine->releaseScratchMidiOwner(
            identifier, static_cast<scratch::DeckSide>(deckIndex + 1));
        if (bridge != nullptr)
            broadcastScratchSessionState(*scratchEngine, *bridge);
    }
}

} // namespace silverdaw
