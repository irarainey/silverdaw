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
 *
 * Authentication
 * ──────────────
 * The server binds to loopback only, but any other process running as the
 * same user can still open a connection. Each connection is therefore
 * gated by a per-session AUTH token: a client's FIRST message must be
 * `{"type":"AUTH","payload":{"token":"<hex>"}}` matching the value
 * registered via `setExpectedToken()` (in turn injected by the Electron
 * main process through the `JACKDAW_BRIDGE_TOKEN` env var / `--token`
 * flag). Until that handshake completes:
 *   • any non-AUTH envelope causes the socket to be closed immediately;
 *   • a wrong-token AUTH envelope also closes the socket;
 *   • `broadcast()` does NOT deliver to that client.
 * On success the server replies with the existing `READY` envelope.
 *
 * If `setExpectedToken()` is never called (or called with an empty
 * string) authentication is disabled and every client is accepted — a
 * convenience for stand-alone manual debugging.
 */
class BridgeServer
{
  public:
    using MessageHandler = std::function<void(const juce::String& type, const juce::var& payload)>;

    BridgeServer();
    ~BridgeServer();

    BridgeServer(const BridgeServer&) = delete;
    BridgeServer& operator=(const BridgeServer&) = delete;

    /**
     * Set the per-session AUTH token required from every connecting
     * client. MUST be called before `start()`; mutating it after the
     * server is running races with the I/O thread. Empty string disables
     * authentication.
     */
    void setExpectedToken(const juce::String& token);

    /** Bind to `ws://127.0.0.1:port` (loopback only) and start serving. Returns true on success. */
    bool start(int port);

    /** Stop the server, disconnect clients. Safe to call multiple times. */
    void stop();

    /**
     * Register the handler called for every parsed incoming message.
     *
     * MUST be called before `start()`. After `start()` the handler is read
     * from the I/O-thread `onIncoming` callback without synchronisation —
     * mutating it concurrently would be a data race. The `jassert` in the
     * implementation catches accidental late registrations in debug builds.
     */
    void onMessage(MessageHandler handler);

    /**
     * Broadcast a JSON envelope `{ type, payload }` to all currently
     * authenticated clients. Pre-AUTH clients are silently skipped.
     */
    void broadcast(const juce::String& type, const juce::var& payload = juce::var());

    /** Number of currently-connected WebSocket clients (authenticated or not). */
    std::size_t getClientCount() const;

  private:
    /** Per-client state held alongside the shared_ptr in `clients`. */
    struct ClientInfo
    {
        std::shared_ptr<ix::WebSocket> socket;
        bool authenticated = false;
    };

    void onIncomingFromClient(ix::WebSocket& webSocket, const std::string& raw);
    /** Returns true if `payload.token` matches `expectedToken`. */
    bool checkAuthToken(const juce::var& payload) const;
    /** Send the post-AUTH `READY` envelope directly to one client. */
    static void sendReadyTo(ix::WebSocket& webSocket);

    std::unique_ptr<ix::WebSocketServer> server;
    MessageHandler messageHandler;
    juce::String expectedToken;

    mutable std::mutex clientsMutex;
    /** Keyed by the raw `ix::WebSocket*` identity from `setOnClientMessageCallback`. */
    std::unordered_map<ix::WebSocket*, ClientInfo> clients;

    std::atomic<bool> running{false};
};

} // namespace jackdaw
