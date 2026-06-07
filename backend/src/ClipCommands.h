#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

// Clip edit commands: lightweight, non-destructive ProjectState mutations on an
// existing clip (move, trim, colour, remove, volume envelope). Extracted from
// Main.cpp so the dispatcher only routes to them. Clip audio ingest (CLIP_ADD,
// editor peaks) is a separate concern and stays with the peaks/decode pipeline.

void handleClipMove(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handleClipTrim(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handleClipColor(const juce::var& payload, ProjectState& projectState);
void handleClipRemove(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                      BridgeServer& bridge);
void handleClipSetEnvelope(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge);

} // namespace silverdaw
