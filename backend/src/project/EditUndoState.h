#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class ProjectState;
class BridgeServer;

// Undo-state envelope used to keep renderer toolbar state in sync.

juce::var buildEditUndoStateEnvelope(ProjectState& projectState);
void broadcastEditUndoState(ProjectState& projectState, BridgeServer& bridge);

} // namespace silverdaw
