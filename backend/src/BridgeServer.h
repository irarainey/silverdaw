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

namespace rook
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
 * main process through the `ROOK_BRIDGE_TOKEN` env var / `--token`
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
    /**
     * Handler invoked for every authenticated inbound envelope. The
     * `BridgeServer&` first argument lets the handler call `broadcast()`
     * to send acknowledgements (e.g. `CLIP_ADDED`) — it can't capture the
     * server by reference because the handler is constructor-injected
     * before the server object exists.
     */
    using MessageHandler = std::function<void(BridgeServer& self, const juce::String& type, const juce::var& payload)>;

    /**
     * Construct a bridge server with the per-session AUTH token and the
     * message handler. Both are frozen for the lifetime of the object:
     * the I/O-thread `onIncoming` callback reads `messageHandler` and
     * `expectedToken` without synchronisation, so constructor injection
     * is what makes that race-free by construction.
     *
     * An empty `expectedToken` disables authentication (stand-alone
     * manual debugging only). A null `handler` is legal but every inbound
     * envelope will be silently dropped.
     */
    BridgeServer(juce::String expectedToken, MessageHandler handler);
    ~BridgeServer();

    BridgeServer(const BridgeServer&) = delete;
    BridgeServer& operator=(const BridgeServer&) = delete;
    BridgeServer(BridgeServer&&) = delete;
    BridgeServer& operator=(BridgeServer&&) = delete;

    /** Bind to `ws://127.0.0.1:port` (loopback only) and start serving. Returns true on success. */
    bool start(int port);

    /** Stop the server, disconnect clients. Safe to call multiple times. */
    void stop();

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
    // Both immutable after construction: the I/O thread reads them lock-free.
    const MessageHandler messageHandler;
    const juce::String expectedToken;

    mutable std::mutex clientsMutex;
    /** Keyed by the raw `ix::WebSocket*` identity from `setOnClientMessageCallback`. */
    std::unordered_map<ix::WebSocket*, ClientInfo> clients;

    std::atomic<bool> running{false};
};

} // namespace rook
