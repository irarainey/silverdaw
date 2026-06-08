#pragma once

#include <atomic>
#include <functional>
#include <juce_core/juce_core.h>
#include <memory>
#include <mutex>
#include <unordered_map>

// Forward-declare so we don't drag the ixwebsocket headers into the public surface.
namespace ix
{
class WebSocketServer;
class WebSocket;
} // namespace ix

namespace silverdaw
{

// Loopback WebSocket bridge; inbound engine mutations are marshalled onto the JUCE message thread.
// Per-session AUTH gates same-user local processes; unauthenticated clients receive no broadcasts.
class BridgeServer
{
  public:
    /** `BridgeServer&` lets constructor-injected handlers broadcast acknowledgements. */
    using MessageHandler = std::function<void(BridgeServer& self, const juce::String& type, const juce::var& payload)>;

    /** Sends initial state to only the freshly-authenticated client. */
    using SendToClient = std::function<void(const juce::String& type, const juce::var& payload)>;

    /** Runs on the JUCE message thread after AUTH so initial-state reads stay thread-safe. */
    using ClientReadyHandler = std::function<void(SendToClient sendToClient)>;

    /** Constructor-injected callbacks stay immutable so I/O-thread reads are race-free. */
    BridgeServer(juce::String expectedToken, MessageHandler handler, ClientReadyHandler readyHandler = {});
    ~BridgeServer();

    BridgeServer(const BridgeServer&) = delete;
    BridgeServer& operator=(const BridgeServer&) = delete;
    BridgeServer(BridgeServer&&) = delete;
    BridgeServer& operator=(BridgeServer&&) = delete;

    /** Binds loopback only. */
    bool start(int port);

    void stop();

    /** Skips pre-AUTH clients. */
    void broadcast(const juce::String& type, const juce::var& payload = juce::var());

    std::size_t getClientCount() const;

  private:
    struct ClientInfo
    {
        std::shared_ptr<ix::WebSocket> socket;
        bool authenticated = false;
    };

    void onIncomingFromClient(ix::WebSocket& webSocket, const std::string& raw);
    bool checkAuthToken(const juce::var& payload) const;
    static void sendReadyTo(ix::WebSocket& webSocket);

    std::unique_ptr<ix::WebSocketServer> server;
    // All three immutable after construction: the I/O thread reads them lock-free.
    const MessageHandler messageHandler;
    const ClientReadyHandler clientReadyHandler;
    const juce::String expectedToken;

    mutable std::mutex clientsMutex;
    std::unordered_map<ix::WebSocket*, ClientInfo> clients;

    std::atomic<bool> running{false};
};

} // namespace silverdaw
