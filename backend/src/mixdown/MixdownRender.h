#pragma once

// Offline mixdown render worker. `renderMixdownAsync` (MixdownEngine.cpp) is a
// thin public wrapper that flips the busy/cancel flags and posts this job to
// the thread pool; the heavy render pipeline lives here so MixdownEngine.cpp
// stays a small facade over the mixdown domain.

#include "MixdownEngine.h"  // MixdownSnapshot, MixdownOptions, BridgeServer fwd

namespace silverdaw
{

void runMixdownJob(MixdownSnapshot snapshot,
                   MixdownOptions options,
                   BridgeServer& bridge,
                   std::atomic<bool>& cancelFlag,
                   std::atomic<bool>& busyFlag);

} // namespace silverdaw
