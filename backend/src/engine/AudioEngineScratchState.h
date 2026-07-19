#pragma once

#include "scratch/BackingMonitorSource.h"
#include "scratch/ScratchAudioSource.h"
#include "scratch/ScratchPatternEvaluator.h"
#include "scratch/ScratchSessionController.h"

#include <atomic>
#include <cstdint>
#include <memory>

namespace silverdaw
{

// Fixed-topology scratch sources and saved-pattern replay state.
class AudioEngineScratchState
{
protected:
    scratch::ScratchAudioSource scratchSource;
    scratch::BackingMonitorSource backingSource;
    scratch::ScratchSessionController scratchController{scratchSource, backingSource};

    std::shared_ptr<const scratch::PatternReplaySnapshot> patternReplaySnapshot;
    std::atomic<bool> patternReplayActive{false};
    std::atomic<std::int64_t> patternReplayPositionUs{0};
};

} // namespace silverdaw
