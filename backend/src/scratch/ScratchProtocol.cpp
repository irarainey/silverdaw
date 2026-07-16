#include "ScratchProtocol.h"
#include "ScratchProtocolInternal.h"

namespace silverdaw::scratch
{
namespace
{

using namespace detail;

std::optional<ControlAction> controlAction(const juce::String& value)
{
    if (value == "play")
    {
        return ControlAction::play;
    }
    if (value == "pause")
    {
        return ControlAction::pause;
    }
    if (value == "recordArm")
    {
        return ControlAction::recordArm;
    }
    if (value == "recordDisarm")
    {
        return ControlAction::recordDisarm;
    }
    if (value == "recordStart")
    {
        return ControlAction::recordStart;
    }
    if (value == "recordStop")
    {
        return ControlAction::recordStop;
    }
    if (value == "seek")
    {
        return ControlAction::seek;
    }
    if (value == "platterMove")
    {
        return ControlAction::platterMove;
    }
    if (value == "platterTouch")
    {
        return ControlAction::platterTouch;
    }
    if (value == "crossfader")
    {
        return ControlAction::crossfader;
    }
    if (value == "backingGain")
    {
        return ControlAction::backingGain;
    }
    if (value == "scratchGain")
    {
        return ControlAction::scratchGain;
    }
    if (value == "backingLoop")
    {
        return ControlAction::backingLoop;
    }
    return std::nullopt;
}

} // namespace

bool hasValidProtocolVersion(const juce::var& payload)
{
    return hasVersion(payload, "protocolVersion", kProtocolVersion);
}

std::optional<SessionOpenPayload> parseSessionOpenPayload(const juce::var& payload)
{
    if (!hasValidProtocolVersion(payload))
    {
        return std::nullopt;
    }
    SessionOpenPayload result;
    if (const auto clipId = requiredString(payload, "clipId"))
    {
        result.clipId = *clipId;
    }
    if (const auto libraryItemId = requiredString(payload, "libraryItemId"))
    {
        result.libraryItemId = *libraryItemId;
    }
    // Exactly one identity is required; both-set is ambiguous.
    if (result.clipId.isEmpty() == result.libraryItemId.isEmpty())
    {
        return std::nullopt;
    }
    return result;
}

std::optional<SessionClosePayload> parseSessionClosePayload(const juce::var& payload)
{
    const auto sessionId = requiredString(payload, "sessionId");
    if (!hasValidProtocolVersion(payload) || !sessionId)
    {
        return std::nullopt;
    }
    return SessionClosePayload{*sessionId};
}

std::optional<BackingPreparePayload> parseBackingPreparePayload(const juce::var& payload)
{
    const auto sessionId = requiredString(payload, "sessionId");
    const auto startAnchor = requiredString(payload, "startAnchor");
    const auto durationValue = finiteNumber(payload, "durationSec");
    if (!hasValidProtocolVersion(payload) || !sessionId || !startAnchor || !durationValue)
    {
        return std::nullopt;
    }
    if (*startAnchor != "arrangement" && *startAnchor != "playhead")
    {
        return std::nullopt;
    }
    const auto durationSec = static_cast<int>(*durationValue);
    // 0 is the full-arrangement sentinel; 60 and 120 are the fixed windows.
    if (durationSec != 0 && durationSec != 60 && durationSec != 120)
    {
        return std::nullopt;
    }
    const auto trackIdsVar = property(payload, "trackIds");
    const auto* array = trackIdsVar ? trackIdsVar->getArray() : nullptr;
    if (array == nullptr)
    {
        return std::nullopt;
    }
    BackingPreparePayload result;
    result.sessionId = *sessionId;
    result.startAnchor = *startAnchor;
    result.durationSec = durationSec;
    result.trackIds.reserve(static_cast<std::size_t>(array->size()));
    for (const auto& item : *array)
    {
        if (!item.isString() || item.toString().isEmpty())
        {
            return std::nullopt;
        }
        result.trackIds.push_back(item.toString());
    }
    return result;
}

std::optional<BackingClearPayload> parseBackingClearPayload(const juce::var& payload)
{
    const auto sessionId = requiredString(payload, "sessionId");
    if (!hasValidProtocolVersion(payload) || !sessionId)
    {
        return std::nullopt;
    }
    return BackingClearPayload{*sessionId};
}

std::optional<SessionControlPayload> parseSessionControlPayload(const juce::var& payload)
{
    const auto sessionId = requiredString(payload, "sessionId");
    const auto actionName = requiredString(payload, "action");
    const auto action = actionName ? controlAction(*actionName) : std::nullopt;
    if (!hasValidProtocolVersion(payload) || !sessionId || !action)
    {
        return std::nullopt;
    }

    SessionControlPayload result;
    result.sessionId = *sessionId;
    result.action = *action;
    switch (*action)
    {
        case ControlAction::play:
        case ControlAction::pause:
        case ControlAction::recordArm:
        case ControlAction::recordDisarm:
        case ControlAction::recordStart:
        case ControlAction::recordStop:
            break;
        case ControlAction::seek:
        {
            const auto position = timeUs(payload, "positionUs");
            if (!position)
            {
                return std::nullopt;
            }
            result.positionUs = *position;
            break;
        }
        case ControlAction::platterMove:
        {
            const auto deck = deckSide(payload, "deck");
            const auto deltaTurns = boundedTurns(payload, "deltaTurns", kMaxEventDeltaTurns);
            if (!deck || !deltaTurns)
            {
                return std::nullopt;
            }
            result.deck = *deck;
            result.deltaTurns = *deltaTurns;
            // Optional monotonic client timestamp; negative/absent leaves 0 so the
            // controller falls back to backend receive time.
            if (const auto clientTime = finiteNumber(payload, "clientTimeMs");
                clientTime && *clientTime >= 0.0)
            {
                result.clientTimeMs = *clientTime;
            }
            break;
        }
        case ControlAction::platterTouch:
        {
            const auto deck = deckSide(payload, "deck");
            const auto touched = requiredBool(payload, "touched");
            if (!deck || !touched)
            {
                return std::nullopt;
            }
            result.deck = *deck;
            result.touched = *touched;
            break;
        }
        case ControlAction::crossfader:
        {
            const auto value = finiteNumber(payload, "value");
            if (!value || *value < 0.0 || *value > 1.0)
            {
                return std::nullopt;
            }
            result.crossfader = *value;
            break;
        }
        case ControlAction::backingGain:
        case ControlAction::scratchGain:
        {
            const auto value = finiteNumber(payload, "value");
            if (!value || *value < 0.0 || *value > 1.0)
            {
                return std::nullopt;
            }
            result.gain = *value;
            break;
        }
        case ControlAction::backingLoop:
        {
            const auto enabled = requiredBool(payload, "enabled");
            if (!enabled)
            {
                return std::nullopt;
            }
            result.loop = *enabled;
            break;
        }
    }
    return result;
}

} // namespace silverdaw::scratch
