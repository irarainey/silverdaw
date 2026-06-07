#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class ProjectState;
class BridgeServer;

// Edit undo-state broadcast. The envelope mirrors the UndoManager's
// canUndo/canRedo + the next undo/redo labels so the renderer can enable
// its toolbar buttons; broadcastEditUndoState pushes it to every client.

juce::var buildEditUndoStateEnvelope(ProjectState& projectState);
void broadcastEditUndoState(ProjectState& projectState, BridgeServer& bridge);

} // namespace silverdaw
