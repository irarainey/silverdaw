#pragma once

#include <juce_core/juce_core.h>

#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace silverdaw
{

enum class PeakResponseTarget
{
    timelineClip,
    clipEditor
};

struct PeakJobWaiter
{
    PeakResponseTarget target;
    juce::String id;
};

struct PeakJobTicket
{
    std::string key;
    bool startsJob = false;
};

// Coalesces worker jobs while preserving every request-specific response.
class PeakJobCoordinator
{
  public:
    PeakJobTicket addWaiter(const juce::File& sourceFile, int peaksPerSecond, PeakJobWaiter waiter);

    std::vector<PeakJobWaiter> takeWaiters(const std::string& key);

  private:
    static std::string makeKey(const juce::File& sourceFile, int peaksPerSecond);

    std::mutex mutex;
    std::unordered_map<std::string, std::vector<PeakJobWaiter>> jobs;
};

} // namespace silverdaw
