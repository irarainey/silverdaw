#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{
class AudioEngine;
class BridgeServer;

// Recording latency calibration (ADR 0030, Amendment 17). Plays a short run of clicks and
// listens for them on the record input, so the head trim can be built from the real round trip
// rather than the fraction of it Windows is willing to report.

/** Starts a measurement against the open record session's input. Answers on
 *  RECORD_CALIBRATE_STATE, always — including when it cannot start. */
void handleRecordCalibrateStart(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge,
                                juce::ThreadPool& peakPool);

/** Abandons a measurement in progress. Harmless when none is running. */
void handleRecordCalibrateCancel(const juce::var& payload, BridgeServer& bridge);

} // namespace silverdaw
