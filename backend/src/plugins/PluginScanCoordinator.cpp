#include "PluginScanCoordinator.h"

#include "PluginScanWorker.h"

#include <juce_events/juce_events.h>

#include <chrono>
#include <condition_variable>
#include <mutex>

namespace silverdaw::plugins
{

// Owns the live scan child and hands its replies to the scanning thread.
class PluginScanCoordinator::WorkerConnection final : private juce::ChildProcessCoordinator
{
  public:
    enum class State
    {
        waiting,
        gotResult,
        connectionLost
    };

    struct Response
    {
        State state = State::waiting;
        std::unique_ptr<juce::XmlElement> xml;
    };

    bool launch()
    {
        return launchWorkerProcess(juce::File::getSpecialLocation(juce::File::currentExecutableFile),
                                   kScanWorkerUid, 0, 0);
    }

    // Short waits keep the scanning thread able to notice cancellation between polls.
    Response awaitResponse()
    {
        std::unique_lock<std::mutex> lock{mutex};
        if (!ready.wait_for(lock, std::chrono::milliseconds{50}, [this] { return gotResult || lost; }))
            return {};

        Response response;
        response.state = lost ? State::connectionLost : State::gotResult;
        response.xml = std::move(resultXml);
        gotResult = false;
        lost = false;
        return response;
    }

    using juce::ChildProcessCoordinator::sendMessageToWorker;

  private:
    void handleMessageFromWorker(const juce::MemoryBlock& block) override
    {
        const std::scoped_lock guard(mutex);
        resultXml = juce::parseXML(block.toString());
        gotResult = true;
        ready.notify_one();
    }

    void handleConnectionLost() override
    {
        const std::scoped_lock guard(mutex);
        lost = true;
        ready.notify_one();
    }

    std::mutex mutex;
    std::condition_variable ready;
    std::unique_ptr<juce::XmlElement> resultXml;
    bool gotResult = false;
    bool lost = false;
};

PluginScanCoordinator::PluginScanCoordinator() = default;
PluginScanCoordinator::~PluginScanCoordinator() = default;

bool PluginScanCoordinator::findPluginTypesFor(juce::AudioPluginFormat& format,
                                               juce::OwnedArray<juce::PluginDescription>& results,
                                               const juce::String& fileOrIdentifier)
{
    if (connection == nullptr)
    {
        auto fresh = std::make_unique<WorkerConnection>();
        if (!fresh->launch()) return false;

        connection = std::move(fresh);
    }

    juce::MemoryBlock request;
    juce::MemoryOutputStream stream{request, true};
    stream.writeString(format.getName());
    stream.writeString(fileOrIdentifier);
    stream.flush();

    if (!connection->sendMessageToWorker(request))
    {
        connection.reset();
        return false;
    }

    for (;;)
    {
        if (shouldExit()) return true;

        auto response = connection->awaitResponse();
        if (response.state == WorkerConnection::State::waiting) continue;

        if (response.xml != nullptr)
        {
            for (const auto* element : response.xml->getChildIterator())
            {
                auto description = std::make_unique<juce::PluginDescription>();
                if (description->loadFromXml(*element)) results.add(std::move(description));
            }
        }

        if (response.state == WorkerConnection::State::connectionLost)
        {
            // This binary killed the child; drop it so the next file starts a fresh one.
            connection.reset();
            return false;
        }

        return true;
    }
}

void PluginScanCoordinator::scanFinished()
{
    connection.reset();
}

} // namespace silverdaw::plugins
