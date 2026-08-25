// Per-track VST3 insert slots in the project tree. Slots are additive children on the track
// (ADR 0019), so an older build simply ignores them, and a slot whose plugin is missing on
// this machine keeps its saved state rather than being dropped (ADR 0025).

#include "ProjectState.h"

#include <vector>

namespace silverdaw
{
namespace
{
const juce::Identifier kPlugin{"PLUGIN"};
const juce::Identifier kPluginIdentifier{"identifier"};
const juce::Identifier kPluginFormat{"format"};
const juce::Identifier kPluginName{"name"};
const juce::Identifier kPluginManufacturer{"manufacturer"};
const juce::Identifier kPluginBypassed{"bypassed"};
const juce::Identifier kPluginState{"state"};

// Absolute child indices of the track's plugin slots, in chain order. Tracks hold clips and
// beat-repeat regions in the same child list, so a slot's chain position is not its index.
std::vector<int> pluginChildIndices(const juce::ValueTree& track)
{
    std::vector<int> indices;
    for (int i = 0; i < track.getNumChildren(); ++i)
        if (track.getChild(i).hasType(kPlugin)) indices.push_back(i);

    return indices;
}

juce::ValueTree findPluginSlot(const juce::ValueTree& track, const juce::Identifier& idProperty,
                               const juce::String& slotId)
{
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto child = track.getChild(i);
        if (child.hasType(kPlugin) && child.getProperty(idProperty).toString() == slotId)
            return child;
    }

    return {};
}
} // namespace

bool ProjectState::addTrackPlugin(const juce::String& trackId, const TrackPluginSlot& slot)
{
    auto track = findTrack(trackId);
    if (!track.isValid() || slot.slotId.isEmpty() || slot.identifier.isEmpty()) return false;
    if (findPluginSlot(track, kId, slot.slotId).isValid()) return false;

    juce::ValueTree node(kPlugin);
    node.setProperty(kId, slot.slotId, &undoManager);
    node.setProperty(kPluginIdentifier, slot.identifier, &undoManager);
    node.setProperty(kPluginFormat, slot.formatName, &undoManager);
    node.setProperty(kPluginName, slot.name, &undoManager);
    node.setProperty(kPluginManufacturer, slot.manufacturer, &undoManager);
    node.setProperty(kPluginBypassed, slot.bypassed, &undoManager);
    if (slot.state.isNotEmpty()) node.setProperty(kPluginState, slot.state, &undoManager);
    track.appendChild(node, &undoManager);
    return true;
}

bool ProjectState::removeTrackPlugin(const juce::String& trackId, const juce::String& slotId)
{
    auto track = findTrack(trackId);
    if (!track.isValid() || slotId.isEmpty()) return false;

    const auto slot = findPluginSlot(track, kId, slotId);
    if (!slot.isValid()) return false;

    track.removeChild(slot, &undoManager);
    return true;
}

bool ProjectState::moveTrackPlugin(const juce::String& trackId, const juce::String& slotId,
                                   int newIndex)
{
    auto track = findTrack(trackId);
    if (!track.isValid() || slotId.isEmpty()) return false;

    const auto slot = findPluginSlot(track, kId, slotId);
    if (!slot.isValid()) return false;

    const auto indices = pluginChildIndices(track);
    if (indices.empty()) return false;

    const auto from = track.indexOf(slot);
    const auto target = juce::jlimit(0, static_cast<int>(indices.size()) - 1, newIndex);
    const auto to = indices[static_cast<std::size_t>(target)];
    if (from == to) return true;

    track.moveChild(from, to, &undoManager);
    return true;
}

bool ProjectState::setTrackPluginBypassed(const juce::String& trackId, const juce::String& slotId,
                                          bool bypassed)
{
    auto track = findTrack(trackId);
    if (!track.isValid() || slotId.isEmpty()) return false;

    auto slot = findPluginSlot(track, kId, slotId);
    if (!slot.isValid()) return false;

    slot.setProperty(kPluginBypassed, bypassed, &undoManager);
    return true;
}

bool ProjectState::setTrackPluginState(const juce::String& trackId, const juce::String& slotId,
                                       const juce::String& base64State)
{
    auto track = findTrack(trackId);
    if (!track.isValid() || slotId.isEmpty()) return false;

    auto slot = findPluginSlot(track, kId, slotId);
    if (!slot.isValid()) return false;

    // State chunks are written on save rather than edited by the user, so they stay out of the
    // undo history: an undo must not restore a stale chunk over the plugin's live settings.
    slot.setProperty(kPluginState, base64State, nullptr);
    return true;
}

std::vector<TrackPluginSlot> ProjectState::getTrackPlugins(const juce::String& trackId) const{
    std::vector<TrackPluginSlot> slots;
    const auto track = findTrack(trackId);
    if (!track.isValid()) return slots;

    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto child = track.getChild(i);
        if (!child.hasType(kPlugin)) continue;

        TrackPluginSlot slot;
        slot.slotId = child.getProperty(kId).toString();
        slot.identifier = child.getProperty(kPluginIdentifier).toString();
        slot.formatName = child.getProperty(kPluginFormat, "VST3").toString();
        slot.name = child.getProperty(kPluginName).toString();
        slot.manufacturer = child.getProperty(kPluginManufacturer).toString();
        slot.bypassed = static_cast<bool>(child.getProperty(kPluginBypassed, false));
        slot.state = child.getProperty(kPluginState, {}).toString();
        if (slot.slotId.isNotEmpty() && slot.identifier.isNotEmpty()) slots.push_back(std::move(slot));
    }

    return slots;
}

void ProjectState::setPluginAvailabilityProbe(std::function<bool(const juce::String&)> probe)
{
    pluginAvailabilityProbe = std::move(probe);
}

} // namespace silverdaw
