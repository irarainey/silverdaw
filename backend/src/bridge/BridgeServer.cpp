#include "BridgeServer.h"
#include "BridgeAuth.h"
#include "Log.h"

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

    // Required before listen() on Windows; balanced in stop().
    ix::initNetSystem();

    // Explicit loopback bind prevents off-host bridge access.
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
        server.reset();
        ix::uninitNetSystem();
        return false;
    }

    server->start();
    running.store(true);
    silverdaw::log::info("bridge", "listening on ws://localhost:" + juce::String(port));
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
  try
  {
    silverdaw::log::debug("bridge", "incoming bytes=" + juce::String(static_cast<int>(raw.size())));
    // AUTH stays on the I/O thread; engine-touching messages hop to the JUCE message thread.
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

    // Keeps the authenticated socket alive until the message-thread ready handler runs.
    std::shared_ptr<ix::WebSocket> readyClient;

    // Close unauthenticated clients on anything except a valid first AUTH.
    {
        std::lock_guard<std::mutex> lock(clientsMutex);
        const auto it = clients.find(&webSocket);
        if (it == clients.end())
        {
            // Client closed between I/O receipt and auth lookup.
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
            // Release the lock before sending through IXWebSocket.
        }
        else if (type == "AUTH")
        {
            // Ignore duplicate AUTH after success.
            return;
        }
        else
        {
            // Constructor-injected handler is immutable, so async capture by `this` is safe.
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

    sendReadyTo(webSocket);

    // Initial-state push runs on the message thread so project reads stay thread-safe.
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
  catch (const std::exception& e)
  {
    // I/O-thread crash firewall: drop the frame instead of terminating the engine.
    silverdaw::log::error("bridge", juce::String("onIncoming threw: ") + e.what() + " — frame dropped");
  }
  catch (...)
  {
    silverdaw::log::error("bridge", "onIncoming threw unknown exception — frame dropped");
  }
}

bool BridgeServer::checkAuthToken(const juce::var& payload) const
{
    return bridge_auth::isTokenValid(expectedToken, payload);
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

// Wire-protocol order is fixed as (type, payload) despite semantic similarity.
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

    // Skip high-rate transport/meter chatter so diagnostics remain readable.
    if (type != "PLAYHEAD_UPDATE" && type != "PREVIEW_POSITION" && type != "MASTER_LEVEL")
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

} // namespace silverdaw
