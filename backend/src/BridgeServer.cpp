#include "BridgeServer.h"

#include <iostream>
#include <ixwebsocket/IXConnectionState.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketMessage.h>
#include <ixwebsocket/IXWebSocketServer.h>
#include <juce_events/juce_events.h>

namespace jackdaw
{

BridgeServer::BridgeServer() = default;

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

    server = std::make_unique<ix::WebSocketServer>(port);

    server->setOnClientMessageCallback(
        [this](const std::shared_ptr<ix::ConnectionState>& /*state*/, ix::WebSocket& webSocket,
               const ix::WebSocketMessagePtr& msg)
        {
            switch (msg->type)
            {
            case ix::WebSocketMessageType::Open:
            {
                {
                    std::lock_guard<std::mutex> lock(clientsMutex);
                    // Find the shared_ptr that backs this WebSocket so we can hold
                    // a reference for `broadcast()`. ixwebsocket exposes this via
                    // `getClients()` on the server.
                    for (const auto& c : server->getClients())
                    {
                        if (c.get() == &webSocket)
                        {
                            clients.insert(c);
                        }
                    }
                }
                // Hello message so the client knows we're up.
                auto* obj = new juce::DynamicObject();
                obj->setProperty("version", "0.1.0");
                broadcast("READY", juce::var(obj));
                break;
            }

            case ix::WebSocketMessageType::Close:
            {
                std::lock_guard<std::mutex> lock(clientsMutex);
                for (auto it = clients.begin(); it != clients.end();)
                {
                    if (it->get() == &webSocket)
                    {
                        it = clients.erase(it);
                    }
                    else
                    {
                        ++it;
                    }
                }
                break;
            }

            case ix::WebSocketMessageType::Message:
                onIncoming(msg->str);
                break;

            case ix::WebSocketMessageType::Error:
                std::cerr << "[bridge] error: " << msg->errorInfo.reason << '\n';
                break;

            default:
                break;
            }
        });

    const auto res = server->listen();
    if (!res.first)
    {
        std::cerr << "[bridge] listen failed: " << res.second << '\n';
        server.reset();
        ix::uninitNetSystem();
        return false;
    }

    server->start();
    running.store(true);
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

void BridgeServer::onIncoming(const std::string& raw)
{
    // Parse JSON on the I/O thread, then dispatch the typed message onto the
    // JUCE message thread so the AudioEngine isn't accessed from multiple threads.
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

    auto handler = messageHandler; // copy for safe capture
    juce::MessageManager::callAsync(
        [handler, type, payload]
        {
            if (handler)
            {
                handler(type, payload);
            }
        });
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

    std::lock_guard<std::mutex> lock(clientsMutex);
    for (const auto& client : clients)
    {
        if (client != nullptr)
        {
            client->send(serialised);
        }
    }
}

std::size_t BridgeServer::getClientCount() const
{
    std::lock_guard<std::mutex> lock(clientsMutex);
    return clients.size();
}

} // namespace jackdaw
