#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;
class PeaksCache;

namespace waveform { struct PeaksResult; }

// Clip-audio + waveform/peaks command handlers. CLIP_ADD ingests a library
// item as a track clip (resolving the engine playback path + scheduling peaks
// and BPM detection); WAVEFORM_REQUEST / CLIP_EDITOR_PEAKS_REQUEST (re)produce
// cached peaks for the timeline and the clip editor. effectivePeaksPerSecond is
// the single source of truth for the broadcast peaks-per-second value (also
// used by sample export in Main.cpp).

double effectivePeaksPerSecond(const waveform::PeaksResult& result);

void handleClipAdd(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                   BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache,
                   const DecodedCache& decodedCache);
void handleWaveformRequest(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache);
void handleClipEditorPeaksRequest(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                                  BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache);

} // namespace silverdaw
