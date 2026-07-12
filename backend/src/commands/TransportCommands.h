#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;

// `mixdownInProgress` prevents transport audio during offline render.
void handleTransportPlay(AudioEngine& engine, bool mixdownInProgress);
void handleTransportPause(AudioEngine& engine);
void handleTransportStop(AudioEngine& engine, ProjectState& projectState);
void handleTransportSeek(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handleTransportScrub(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);

} // namespace silverdaw
