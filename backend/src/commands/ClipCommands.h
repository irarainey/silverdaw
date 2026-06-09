#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

// Clip ingest stays with the peaks/decode pipeline; edits are non-destructive.

void handleClipMove(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handleClipTrim(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handleClipColor(const juce::var& payload, ProjectState& projectState);
void handleClipRemove(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                      BridgeServer& bridge);
void handleClipSetEnvelope(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge);
void handleClipSetLocked(const juce::var& payload, ProjectState& projectState);
void handleClipSetReversed(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handleClipRename(const juce::var& payload, ProjectState& projectState);
void handleClipRebind(const juce::var& payload, ProjectState& projectState);
void handleClipSetWarp(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge);

} // namespace silverdaw
