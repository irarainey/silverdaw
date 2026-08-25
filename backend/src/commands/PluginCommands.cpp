// VST3 insert commands (ADR 0025). The project tree is the authority for what a track's
// chain contains; the engine is the authority for the live plugin instances and their state.
// Every handler here mutates both, then tells the renderer what changed — never an optimistic
// local guess. Adding, removing and reordering rebroadcast PROJECT_STATE because they mint
// slot ids and clamp chain order backend-side, so only a full snapshot is self-consistent.
// Bypass instead acks narrowly: it cannot change slot identity or order, and resending the
// whole project to flip one boolean forced a full timeline repaint on every click.

#include "PluginCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "CommandHelpers.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "PluginChain.h"
#include "ProjectSession.h"
#include "ProjectState.h"

#include <juce_events/juce_events.h>

namespace silverdaw
{
namespace
{
juce::var buildPluginListEnvelope(AudioEngine& engine)
{
    auto& catalogue = engine.pluginCatalogue();

    juce::Array<juce::var> plugins;
    for (const auto& description : catalogue.getKnownPlugins())
    {
        // Instruments are listed but flagged: only effects can be used as an insert in v1.
        auto* obj = new juce::DynamicObject();
        obj->setProperty("identifier", description.fileOrIdentifier);
        obj->setProperty("name", description.name);
        obj->setProperty("manufacturer", description.manufacturerName);
        obj->setProperty("category", description.category);
        obj->setProperty("format", description.pluginFormatName);
        obj->setProperty("isInstrument", description.isInstrument);
        plugins.add(juce::var(obj));
    }

    juce::Array<juce::var> blacklisted;
    for (const auto& file : catalogue.getBlacklistedFiles()) blacklisted.add(file);

    auto* envelope = new juce::DynamicObject();
    envelope->setProperty("plugins", plugins);
    envelope->setProperty("blacklisted", blacklisted);
    envelope->setProperty("scanning", catalogue.isScanning());
    return juce::var(envelope);
}

std::optional<juce::PluginDescription> findDescription(AudioEngine& engine,
                                                       const juce::String& identifier)
{
    for (const auto& description : engine.pluginCatalogue().getKnownPlugins())
        if (description.fileOrIdentifier == identifier) return description;

    return std::nullopt;
}

void broadcastProjectState(ProjectState& projectState, BridgeServer& bridge,
                           ProjectSession& session)
{
    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
}

void broadcastPluginNotice(BridgeServer& bridge, const juce::String& message,
                          const char* severity)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("message", message);
    obj->setProperty("severity", juce::String(severity));
    bridge.broadcast("PLUGIN_NOTICE", juce::var(obj));
}

// These are curated, user-facing strings, unlike the raw handler faults ENGINE_ERROR
// carries — so they get their own envelope and are shown verbatim.
void broadcastPluginError(BridgeServer& bridge, const juce::String& message)
{
    broadcastPluginNotice(bridge, message, "error");
}

struct SlotRef
{
    juce::String trackId;
    juce::String slotId;
    bool valid = false;
};

// Inserts are fed stereo audio and no MIDI (ADR 0025). A plugin that wanted more still
// loads and runs, so the only symptom is that it sounds wrong or not at all — which is
// indistinguishable from a fault unless the user is told which input is missing.
void warnIfUnderfed(BridgeServer& bridge, const juce::String& name,
                    const plugins::PluginSlotIo& io)
{
    if (!io.resolved) return;

    const bool needsSideChain = io.inputChannels > 2;
    if (!needsSideChain && !io.acceptsMidi) return;

    juce::StringArray wanted;
    if (io.acceptsMidi) wanted.add("MIDI notes");
    if (needsSideChain) wanted.add("a side-chain input");

    broadcastPluginNotice(bridge, name + " expects " + wanted.joinIntoString(" and ") +
                                      ", which Silverdaw does not send to plugins, so it may "
                                      "produce little or no sound. Effects that work on the "
                                      "track audio alone are unaffected.",
                          "info");
}

SlotRef readSlotRef(const juce::var& payload)
{
    SlotRef ref;
    ref.trackId = bridge::tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    ref.slotId = bridge::tryGetRequiredString(payload, "slotId").value_or(juce::String{});
    ref.valid = ref.trackId.isNotEmpty() && ref.slotId.isNotEmpty();
    return ref;
}
} // namespace

void broadcastPluginList(AudioEngine& engine, BridgeServer& bridge)
{
    bridge.broadcast("PLUGIN_LIST", buildPluginListEnvelope(engine));
}

void handlePluginListRequest(AudioEngine& engine, BridgeServer& bridge)
{
    broadcastPluginList(engine, bridge);
}

void handlePluginScan(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge)
{
    auto& catalogue = engine.pluginCatalogue();
    if (bridge::readOptionalBool(payload, "clearBlacklist").value_or(false)) catalogue.clearBlacklist();

    // Progress and completion arrive on the scan thread, so both hops back to the message
    // thread before touching the bridge.
    const bool started = catalogue.startScan(
        catalogue.getSearchPaths(),
        [enginePtr = &engine, bridgePtr = &bridge](plugins::ScanProgress progress) {
            juce::MessageManager::callAsync([bridgePtr, progress]() {
                auto* obj = new juce::DynamicObject();
                obj->setProperty("currentFile", progress.currentPlugin);
                obj->setProperty("scanned", progress.scanned);
                obj->setProperty("total", progress.total);
                bridgePtr->broadcast("PLUGIN_SCAN_PROGRESS", juce::var(obj));
            });
            juce::ignoreUnused(enginePtr);
        },
        [enginePtr = &engine, bridgePtr = &bridge](bool completed) {
            juce::MessageManager::callAsync([enginePtr, bridgePtr, completed]() {
                auto* obj = new juce::DynamicObject();
                obj->setProperty("scanned", 0);
                obj->setProperty("total", 0);
                obj->setProperty("finished", true);
                bridgePtr->broadcast("PLUGIN_SCAN_PROGRESS", juce::var(obj));
                broadcastPluginList(*enginePtr, *bridgePtr);
                log::info("plugins", completed ? "scan finished" : "scan cancelled");
            });
        });

    if (!started) log::debug("plugins", "PLUGIN_SCAN ignored (a scan is already running)");

    // Tell the renderer immediately that a scan is in flight, so its button can settle.
    broadcastPluginList(engine, bridge);
}

void handleTrackAddPlugin(const juce::var& payload, AudioEngine& engine,
                          ProjectState& projectState, BridgeServer& bridge,
                          ProjectSession& session)
{
    const auto trackId = bridge::tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    const auto identifier =
        bridge::tryGetRequiredString(payload, "identifier").value_or(juce::String{});
    if (trackId.isEmpty() || identifier.isEmpty()) return;

    const auto description = findDescription(engine, identifier);
    if (!description.has_value())
    {
        broadcastPluginError(bridge, "That plugin is no longer installed. Rescan and try again.");
        return;
    }

    if (description->isInstrument)
    {
        // v1 hosts effects only; an instrument in an insert slot would have nothing to play.
        broadcastPluginError(bridge, description->name + " is an instrument, and Silverdaw "
                                                         "currently hosts effect plugins only.");
        return;
    }

    juce::String errorMessage;
    const auto slotId = engine.addTrackPlugin(trackId, *description, /*state*/ {},
                                              /*bypassed*/ false, errorMessage);
    if (slotId.isEmpty()) return;

    TrackPluginSlot slot;
    slot.slotId = slotId;
    slot.identifier = description->fileOrIdentifier;
    slot.formatName = description->pluginFormatName;
    slot.name = description->name;
    slot.manufacturer = description->manufacturerName;
    projectState.addTrackPlugin(trackId, slot);

    if (errorMessage.isNotEmpty())
    {
        broadcastPluginError(bridge, description->name + " could not be loaded: " + errorMessage);
    }
    else
    {
        warnIfUnderfed(bridge, description->name, engine.getTrackPluginIo(trackId, slotId));
    }

    broadcastProjectState(projectState, bridge, session);
}

void handleTrackRemovePlugin(const juce::var& payload, AudioEngine& engine,
                             ProjectState& projectState, BridgeServer& bridge,
                             ProjectSession& session)
{
    const auto ref = readSlotRef(payload);
    if (!ref.valid) return;

    engine.removeTrackPlugin(ref.trackId, ref.slotId);
    if (!projectState.removeTrackPlugin(ref.trackId, ref.slotId)) return;

    broadcastProjectState(projectState, bridge, session);
}

void handleTrackReorderPlugin(const juce::var& payload, AudioEngine& engine,
                              ProjectState& projectState, BridgeServer& bridge,
                              ProjectSession& session)
{
    const auto ref = readSlotRef(payload);
    const auto index = bridge::tryGetNumber(payload, "index");
    if (!ref.valid || !index.has_value()) return;

    const int newIndex = static_cast<int>(*index);
    engine.moveTrackPlugin(ref.trackId, ref.slotId, newIndex);
    if (!projectState.moveTrackPlugin(ref.trackId, ref.slotId, newIndex)) return;

    broadcastProjectState(projectState, bridge, session);
}

void handleTrackSetPluginBypass(const juce::var& payload, AudioEngine& engine,
                                ProjectState& projectState, BridgeServer& bridge)
{
    const auto ref = readSlotRef(payload);
    const auto bypassed = bridge::readOptionalBool(payload, "bypassed");
    if (!ref.valid || !bypassed.has_value()) return;

    engine.setTrackPluginBypassed(ref.trackId, ref.slotId, *bypassed);
    const bool stored = projectState.setTrackPluginBypassed(ref.trackId, ref.slotId, *bypassed);
    // A narrow ack, not a project snapshot: bypass leaves the chain's shape untouched, so the
    // renderer needs one flag rather than a rebuild of every track and clip. `stored` false
    // means the slot vanished between the click and the command, and the renderer leaves its
    // mirror alone.
    broadcastApplied(bridge, "TRACK_PLUGIN_BYPASS_APPLIED",
                     {{"trackId", ref.trackId}, {"slotId", ref.slotId}, {"bypassed", *bypassed}},
                     stored);
}

void handleTrackOpenPluginEditor(const juce::var& payload, AudioEngine& engine,
                                 ProjectState& projectState, BridgeServer& bridge)
{
    const auto ref = readSlotRef(payload);
    if (!ref.valid) return;

    juce::String title;
    for (const auto& slot : projectState.getTrackPlugins(ref.trackId))
        if (slot.slotId == ref.slotId) title = slot.name;

    if (!engine.openTrackPluginEditor(ref.trackId, ref.slotId, title))
    {
        broadcastPluginError(bridge,
                             "That plugin is not loaded, so its controls cannot be opened.");
    }
}

} // namespace silverdaw
