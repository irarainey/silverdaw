#pragma once

// Background stem-separation job. Mirrors MixdownEngine: flips a busy flag, runs
// the (injected) separator on a JUCE ThreadPool worker, streams STEM_PROGRESS,
// and emits STEM_READY / STEM_FAILED. The separator and bridge must outlive the
// job (the dispatch layer owns both for the process lifetime).

#include <atomic>

#include <juce_core/juce_core.h>

#include "StemSeparator.h"

namespace silverdaw
{

class BridgeServer;

void runStemSeparationAsync(StemSeparationRequest request,
                            StemSeparator& separator,
                            juce::ThreadPool& pool,
                            BridgeServer& bridge,
                            std::atomic<bool>& cancelFlag,
                            std::atomic<bool>& busyFlag);

// Synchronous job body, exposed for the test harness to exercise without a pool.
void runStemSeparationJob(StemSeparationRequest request,
                          StemSeparator& separator,
                          BridgeServer& bridge,
                          std::atomic<bool>& cancelFlag,
                          std::atomic<bool>& busyFlag);

} // namespace silverdaw
