#pragma once


#include "MixdownEngine.h"  // MixdownSnapshot, MixdownOptions, BridgeServer fwd

namespace silverdaw
{

void runMixdownJob(const MixdownSnapshot& snapshot, MixdownOptions options, BridgeServer& bridge,
                   std::atomic<bool>& cancelFlag, std::atomic<bool>& busyFlag);

} // namespace silverdaw
