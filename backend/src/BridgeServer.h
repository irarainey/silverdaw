#pragma once

#include <atomic>
#include <functional>
#include <juce_core/juce_core.h>
#include <memory>
#include <mutex>
#include <unordered_set>

// Forward-declare so we don't drag the ixwebsocket headers into the public surface.
namespace ix
{
class WebSocketServer;
class WebSocket;
} // namespace ix

namespace jackdaw
{

/**
 * Local WebSocket bridge between the Electron renderer and the JUCE backend.
 *
 * Incoming messages are JSON objects `{ "type": "...", "payload": {...} }`
 * and arrive on ixwebsocket's I/O threads. They are marshalled onto the
 * JUCE message thread via `juce::MessageManager::callAsync` before
 * dispatching to `messageHandler`, so engine-touching code never has to
 * worry about audio-thread / I/O-thread interleaving.
 *
 * Outgoing messages (`broadcast`) are sent on the calling thread directly;
 * ixwebsocket internally serialises sends per-client.
 */
class BridgeServer
{
  public:
    using MessageHandler = std::function<void(const juce::String& type, const juce::var& payload)>;

    BridgeServer();
    ~BridgeServer();

    BridgeServer(const BridgeServer&) = delete;
    BridgeServer& operator=(const BridgeServer&) = delete;

    /** Bind to `ws://0.0.0.0:port` and start serving. Returns true on success. */
    bool start(int port);

    /** Stop the server, disconnect clients. Safe to call multiple times. */
    void stop();

    /** Register the handler called for every parsed incoming message. */
    void onMessage(MessageHandler handler)
    {
        messageHandler = std::move(handler);
    }

    /** Broadcast a JSON envelope `{ type, payload }` to all connected clients. */
    void broadcast(const juce::String& type, const juce::var& payload = juce::var());

    /** Number of currently-connected WebSocket clients. */
    std::size_t getClientCount() const;

  private:
    void onIncoming(const std::string& raw);

    std::unique_ptr<ix::WebSocketServer> server;
    MessageHandler messageHandler;

    mutable std::mutex clientsMutex;
    std::unordered_set<std::shared_ptr<ix::WebSocket>> clients;

    std::atomic<bool> running{false};
};

} // namespace jackdaw
