#include "EditUndoState.h"

#include "BridgeServer.h"
#include "ProjectState.h"

namespace silverdaw
{

juce::var buildEditUndoStateEnvelope(silverdaw::ProjectState& projectState)
{
    auto& um = projectState.getUndoManager();
    auto* obj = new juce::DynamicObject();
    const bool canUndo = um.canUndo();
    const bool canRedo = um.canRedo();
    obj->setProperty("canUndo", canUndo);
    obj->setProperty("canRedo", canRedo);
    if (canUndo)
    {
        const auto label = um.getUndoDescription();
        if (label.isNotEmpty()) obj->setProperty("undoLabel", label);
    }
    if (canRedo)
    {
        const auto label = um.getRedoDescription();
        if (label.isNotEmpty()) obj->setProperty("redoLabel", label);
    }
    return juce::var(obj);
}

void broadcastEditUndoState(silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    bridge.broadcast("EDIT_UNDO_STATE", buildEditUndoStateEnvelope(projectState));
}

} // namespace silverdaw
