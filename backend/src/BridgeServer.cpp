#include "BridgeServer.h"
#include "Log.h"

#include <iostream>
#include <ixwebsocket/IXConnectionState.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketMessage.h>
#include <ixwebsocket/IXWebSocketServer.h>
#include <juce_events/juce_events.h>

namespace silverdaw
{

BridgeServer::BridgeServer(juce::String expectedTokenIn, MessageHandler handler, ClientReadyHandler readyHandler)
    : messageHandler(std::move(handler)), clientReadyHandler(std::move(readyHandler)),
      expectedToken(std::move(expectedTokenIn))
{
}

BridgeServer::~BridgeServer()
{
    stop();
}

bool BridgeServer::start(int port)
{
    if (running.load())
    {
        return true;
    }

    // On Windows this calls WSAStartup; on POSIX it is a no-op. Required
    // before any socket(2) / setsockopt(2) call, otherwise listen() fails
    // with "setsockopt(SO_REUSEADDR) ... Unknown error". Reference counted
    // and balanced by ix::uninitNetSystem() in stop().
    ix::initNetSystem();

    // Explicit loopback bind: the bridge is renderer<->backend only and must
    // never accept connections from off-host (the renderer lives in the same
    // Electron process tree). Don't rely on IXWebSocket's default host.
    server = std::make_unique<ix::WebSocketServer>(port, "127.0.0.1");

    server->setOnClientMessageCallback(
        [this](const std::shared_ptr<ix::ConnectionState>& /*state*/, ix::WebSocket& webSocket,
               const ix::WebSocketMessagePtr& msg)
        {
            switch (msg->type)
            {
            case ix::WebSocketMessageType::Open:
            {
                std::lock_guard<std::mutex> lock(clientsMutex);
                for (const auto& c : server->getClients())
                {
                    if (c.get() == &webSocket)
                    {
                        ClientInfo info;
                        info.socket = c;
                        info.authenticated = expectedToken.isEmpty();
                        clients.insert_or_assign(c.get(), std::move(info));
                    }
                }
                silverdaw::log::info("bridge", "client connected (auth=" + juce::String(expectedToken.isEmpty() ? "disabled" : "pending") + ")");
                if (expectedToken.isEmpty())
                {
                    sendReadyTo(webSocket);
                }
                break;
            }

            case ix::WebSocketMessageType::Close:
            {
                std::lock_guard<std::mutex> lock(clientsMutex);
                clients.erase(&webSocket);
                silverdaw::log::info("bridge", "client disconnected; remaining=" + juce::String(static_cast<int>(clients.size())));
                break;
            }

            case ix::WebSocketMessageType::Message:
                onIncomingFromClient(webSocket, msg->str);
                break;

            case ix::WebSocketMessageType::Error:
                silverdaw::log::error("bridge", juce::String("ws error: ") + juce::String(msg->errorInfo.reason));
                break;

            default:
                break;
            }
        });

    const auto res = server->listen();
    if (!res.first)
    {
        silverdaw::log::error("bridge", juce::String("listen failed: ") + juce::String(res.second));
        std::cerr << "[bridge] listen failed: " << res.second << '\n';
        server.reset();
        ix::uninitNetSystem();
        return false;
    }

    server->start();
    running.store(true);
    silverdaw::log::info("bridge", "listening on ws://localhost:" + juce::String(port));
    std::cout << "[bridge] listening on ws://localhost:" << port << '\n';
    return true;
}

void BridgeServer::stop()
{
    if (!running.load())
    {
        return;
    }
    running.store(false);

    {
        std::lock_guard<std::mutex> lock(clientsMutex);
        clients.clear();
    }

    if (server != nullptr)
    {
        server->stop();
        server.reset();
    }

    ix::uninitNetSystem();
}

void BridgeServer::onIncomingFromClient(ix::WebSocket& webSocket, const std::string& raw)
{
    silverdaw::log::debug("bridge", "incoming bytes=" + juce::String(static_cast<int>(raw.size())));
    // Parse JSON on the I/O thread, then either consume the envelope here
    // (AUTH handshake) or dispatch the typed message onto the JUCE message
    // thread so the AudioEngine isn't accessed from multiple threads.
    juce::var parsed = juce::JSON::parse(juce::String(raw));
    if (!parsed.isObject())
    {
        return;
    }

    juce::String type = parsed.getProperty("type", juce::var()).toString();
    juce::var payload = parsed.getProperty("payload", juce::var());

    if (type.isEmpty())
    {
        return;
    }

    // Captured here so the post-AUTH initial-state push can target this
    // specific client. Held as a shared_ptr so the socket survives even
    // if the client disconnects between the I/O thread and the message
    // thread running the ready handler.
    std::shared_ptr<ix::WebSocket> readyClient;

    // Auth gate: every envelope from a non-authenticated client must be an
    // `AUTH` carrying the expected token. Anything else (including a wrong
    // token) gets the connection slammed shut so a misbehaving local
    // process can't keep probing.
    {
        std::lock_guard<std::mutex> lock(clientsMutex);
        const auto it = clients.find(&webSocket);
        if (it == clients.end())
        {
            // We don't know this client (it must have closed between the
            // I/O thread reading the message and us getting here). Drop.
            return;
        }
        if (!it->second.authenticated)
        {
            if (type != "AUTH" || !checkAuthToken(payload))
            {
                silverdaw::log::warn("bridge", "auth failed; closing client");
                webSocket.close();
                clients.erase(it);
                return;
            }
            it->second.authenticated = true;
            readyClient = it->second.socket;
            silverdaw::log::info("bridge", "client authenticated");
            // Send READY now that the client is trusted. Release the lock
            // around the send so we don't hold it across IXWebSocket's
            // internal mutex.
        }
        else if (type == "AUTH")
        {
            // Re-sending AUTH after success is harmless; just ignore it so
            // we don't double-dispatch a meaningless message to the engine.
            return;
        }
        else
        {
            // Authenticated, non-AUTH message: fall through to dispatch.
            // `messageHandler` is `const` and set by the constructor, so
            // it's safe to reference from the async lambda without a copy.
            juce::MessageManager::callAsync(
                [this, type, payload]
                {
                    if (messageHandler)
                    {
                        messageHandler(*this, type, payload);
                    }
                });
            return;
        }
    }

    // Reached only on a successful AUTH transition.
    sendReadyTo(webSocket);

    // Post-AUTH initial state push (e.g. PROJECT_STATE). Runs on the
    // JUCE message thread so the handler can read engine/project state
    // without locking. `readyClient` keeps the socket alive in the
    // closure even if the connection drops before the handler fires.
    if (clientReadyHandler && readyClient)
    {
        juce::MessageManager::callAsync(
            [this, readyClient]
            {
                if (!clientReadyHandler)
                {
                    return;
                }
                auto sendToClient = [readyClient](const juce::String& sendType, const juce::var& sendPayload)
                {
                    if (!readyClient)
                    {
                        return;
                    }
                    auto* env = new juce::DynamicObject();
                    env->setProperty("type", sendType);
                    if (!sendPayload.isVoid())
                    {
                        env->setProperty("payload", sendPayload);
                    }
                    const auto serialised = juce::JSON::toString(juce::var(env), true).toStdString();
                    readyClient->send(serialised);
                };
                clientReadyHandler(std::move(sendToClient));
            });
    }
}

bool BridgeServer::checkAuthToken(const juce::var& payload) const
{
    if (expectedToken.isEmpty())
    {
        return true;
    }
    const juce::String token = payload.getProperty("token", juce::var()).toString();
    // Length check first short-circuits the per-char loop on the common
    // mismatch case while still letting the inner loop run constant-time
    // on matching-length inputs (defence against trivial timing attacks).
    if (token.length() != expectedToken.length())
    {
        return false;
    }
    int diff = 0;
    for (int i = 0; i < expectedToken.length(); ++i)
    {
        diff |= static_cast<int>(expectedToken[i]) ^ static_cast<int>(token[i]);
    }
    return diff == 0;
}

void BridgeServer::sendReadyTo(ix::WebSocket& webSocket)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("version", "1.0.0");

    auto* envelope = new juce::DynamicObject();
    envelope->setProperty("type", juce::String("READY"));
    envelope->setProperty("payload", juce::var(obj));

    const auto serialised = juce::JSON::toString(juce::var(envelope), true).toStdString();
    webSocket.send(serialised);
}

// `type` and `payload` differ semantically (envelope-type tag vs. arbitrary
// JSON body); the (type, payload) order is the wire-protocol convention
// shared with the renderer and intentionally fixed.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void BridgeServer::broadcast(const juce::String& type, const juce::var& payload)
{
    if (!running.load())
    {
        return;
    }

    auto* envelope = new juce::DynamicObject();
    envelope->setProperty("type", type);
    if (!payload.isVoid())
    {
        envelope->setProperty("payload", payload);
    }

    const auto serialised = juce::JSON::toString(juce::var(envelope), true).toStdString();

    // Skip the 60 Hz playhead chatter; everything else is rare enough
    // that one line per envelope is useful for diagnostics.
    if (type != "PLAYHEAD_UPDATE")
    {
        silverdaw::log::info("bridge", "broadcast " + type + " bytes=" + juce::String(static_cast<int>(serialised.size())));
    }

    std::lock_guard<std::mutex> lock(clientsMutex);
    for (const auto& [_, info] : clients)
    {
        if (info.authenticated && info.socket != nullptr)
        {
            info.socket->send(serialised);
        }
    }
}

std::size_t BridgeServer::getClientCount() const
{
    std::lock_guard<std::mutex> lock(clientsMutex);
    return clients.size();
}

void BridgeServer::broadcastBinary(const std::string& frameBytes)
{
    if (!running.load() || frameBytes.empty())
    {
        return;
    }
    int deliveredTo = 0;
    int skippedNoAuth = 0;
    {
        std::lock_guard<std::mutex> lock(clientsMutex);
        for (const auto& [_, info] : clients)
        {
            if (info.authenticated && info.socket != nullptr)
            {
                info.socket->sendBinary(frameBytes);
                ++deliveredTo;
            }
            else
            {
                ++skippedNoAuth;
            }
        }
    }
    silverdaw::log::info("bridge", "broadcastBinary bytes=" + juce::String(static_cast<int>(frameBytes.size())) +
                                       " delivered=" + juce::String(deliveredTo) +
                                       " skipped=" + juce::String(skippedNoAuth));
}

} // namespace silverdaw
