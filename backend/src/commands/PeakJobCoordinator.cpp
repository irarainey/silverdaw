#include "PeakJobCoordinator.h"

#include <algorithm>
#include <utility>

namespace silverdaw
{

std::string PeakJobCoordinator::makeKey(const juce::File& sourceFile, int peaksPerSecond)
{
    return sourceFile.getFullPathName().toLowerCase().toStdString() + "|" + std::to_string(peaksPerSecond);
}

PeakJobTicket PeakJobCoordinator::addWaiter(const juce::File& sourceFile, int peaksPerSecond,
                                            PeakJobWaiter waiter)
{
    auto key = makeKey(sourceFile, peaksPerSecond);
    const std::lock_guard<std::mutex> lock(mutex);
    auto [it, inserted] = jobs.try_emplace(key);
    auto& waiters = it->second;
    const auto duplicate = std::find_if(waiters.begin(), waiters.end(), [&waiter](const PeakJobWaiter& existing)
    {
        return existing.target == waiter.target && existing.id == waiter.id;
    });
    if (duplicate == waiters.end())
    {
        waiters.push_back(std::move(waiter));
    }
    return {std::move(key), inserted};
}

std::vector<PeakJobWaiter> PeakJobCoordinator::takeWaiters(const std::string& key)
{
    const std::lock_guard<std::mutex> lock(mutex);
    const auto it = jobs.find(key);
    if (it == jobs.end())
    {
        return {};
    }
    auto waiters = std::move(it->second);
    jobs.erase(it);
    return waiters;
}

} // namespace silverdaw
