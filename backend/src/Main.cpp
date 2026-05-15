#include "AudioEngine.h"
#include "BridgeServer.h"

#include <atomic>
#include <csignal>
#include <iostream>
#include <juce_events/juce_events.h>
#include <string>
#include <string_view>

//==============================================================================
// Jackdaw headless audio backend - entry point.
//
// Lifecycle:
//   1. Initialise JUCE GUI singletons (MessageManager, AudioFormatManager pool).
//   2. Spin up the audio engine (default output device, stereo).
//   3. Start the WebSocket bridge on ws://localhost:8765.
//   4. Run the JUCE message dispatch loop. Audio runs on its own thread,
//      WebSocket I/O runs on ixwebsocket's threads; all engine mutations
//      are marshalled onto the message thread for safety.
//
// NOTE: keep string literals ASCII-only. juce::String(const char*) asserts on
// any byte > 127. For Unicode text, wrap with juce::CharPointer_UTF8.
//==============================================================================

namespace
{
constexpr int kDefaultBridgePort = 8765;
constexpr int kMinBridgePort = 1024;
constexpr int kMaxBridgePort = 65535;
constexpr int kPlayheadUpdateHz = 60;

std::atomic<bool> g_shouldQuit{false};

void onSignal(int /*sig*/)
{
    g_shouldQuit.store(true);
    juce::MessageManager::getInstance()->stopDispatchLoop();
}

/**
 * Parse an integer port from a string. Returns the parsed value on success,
 * or `kDefaultBridgePort` on any failure (out of range / non-numeric /
 * trailing garbage). A warning is emitted on stderr in the failure path so
 * silent fallbacks remain debuggable.
 */
int parsePort(std::string_view value, std::string_view source)
{
    if (value.empty())
    {
        return kDefaultBridgePort;
    }

    int port = 0;
    try
    {
        std::size_t consumed = 0;
        port = std::stoi(std::string(value), &consumed);
        if (consumed != value.size())
        {
            throw std::invalid_argument("trailing characters");
        }
    }
    catch (const std::exception& e)
    {
        std::cerr << "[main] invalid port from " << source << " (" << value << "): " << e.what() << "; using default "
                  << kDefaultBridgePort << '\n';
        return kDefaultBridgePort;
    }

    if (port < kMinBridgePort || port > kMaxBridgePort)
    {
        std::cerr << "[main] port " << port << " from " << source << " outside [" << kMinBridgePort << ", "
                  << kMaxBridgePort << "]; using default " << kDefaultBridgePort << '\n';
        return kDefaultBridgePort;
    }

    return port;
}

/**
 * Resolve the bridge listen port. Precedence (highest first):
 *   1. `--port <N>` or `--port=N` command-line argument
 *   2. `JACKDAW_BRIDGE_PORT` environment variable
 *   3. compiled-in default (`kDefaultBridgePort`)
 *
 * The Electron main process picks an unused loopback port and passes it
 * via `--port` so multiple Jackdaw instances can run side-by-side without
 * colliding on 8765.
 */
// `argv` is necessarily a C-style array — that's the only legal signature for
// `main` and forwarded helpers. clang-tidy's modernize check doesn't model that.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int resolveBridgePort(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string_view arg{argv[i]};
        if (arg == "--port" && i + 1 < argc)
        {
            return parsePort(argv[i + 1], "--port");
        }
        constexpr std::string_view prefix = "--port=";
        if (arg.size() > prefix.size() && arg.substr(0, prefix.size()) == prefix)
        {
            return parsePort(arg.substr(prefix.size()), "--port=");
        }
    }

    // JUCE's wrapper is portable AND silences the MSVC "getenv is unsafe"
    // deprecation noise without a per-translation-unit pragma.
    const juce::String envValue = juce::SystemStats::getEnvironmentVariable("JACKDAW_BRIDGE_PORT", {});
    if (envValue.isNotEmpty())
    {
        return parsePort(envValue.toStdString(), "JACKDAW_BRIDGE_PORT");
    }

    return kDefaultBridgePort;
}

/** Polls the audio engine and broadcasts PLAYHEAD_UPDATE while playing. */
class PlayheadEmitter : public juce::Timer
{
  public:
    PlayheadEmitter(jackdaw::AudioEngine& e, jackdaw::BridgeServer& b)
        : engine(e), bridge(b), payloadObject(new juce::DynamicObject()), payload(payloadObject.get())
    {
    }

    void timerCallback() override
    {
        const bool playing = engine.isPlaying();
        const double posMs = engine.getPositionMs();

        // Always broadcast on transitions; while playing, broadcast every tick so the
        // renderer can drive a smooth playhead. Reuse a single DynamicObject so we
        // don't churn the heap 60x/s on the message thread.
        if (playing || posMs != lastPosMs)
        {
            payloadObject->setProperty("positionMs", posMs);
            payloadObject->setProperty("isPlaying", playing);
            bridge.broadcast("PLAYHEAD_UPDATE", payload);
            lastPosMs = posMs;
        }
    }

  private:
    jackdaw::AudioEngine& engine;
    jackdaw::BridgeServer& bridge;
    // Reference-counted: held alive by `payloadObject`; `payload` is the
    // pre-wrapped juce::var we hand to broadcast() each tick.
    juce::DynamicObject::Ptr payloadObject;
    juce::var payload;
    double lastPosMs = -1.0;
};

void handleClipAdd(const juce::var& payload, jackdaw::AudioEngine& engine, jackdaw::BridgeServer& bridge)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    const juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
    if (trackId.isEmpty() || filePath.isEmpty())
    {
        return;
    }

    juce::String errorMsg;
    const bool ok = engine.addClip(trackId, juce::File(filePath), &errorMsg);
    if (ok)
    {
        // Apply the requested timeline offset so the clip plays back at the
        // position the frontend chose (e.g. at the current playhead).
        const double positionMs = static_cast<double>(payload.getProperty("positionMs", 0.0));
        if (positionMs > 0.0)
        {
            engine.setClipOffsetMs(trackId, positionMs);
        }
    }
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("filePath", filePath);
    p->setProperty("ok", ok);
    if (!ok)
        p->setProperty("error", errorMsg);
    bridge.broadcast(ok ? "CLIP_ADDED" : "CLIP_ADD_FAILED", juce::var(p));
}

void handleClipMove(const juce::var& payload, jackdaw::AudioEngine& engine)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    const double positionMs = static_cast<double>(payload.getProperty("positionMs", 0.0));
    engine.setClipOffsetMs(trackId, positionMs);
}

void handleTrackRemove(const juce::var& payload, jackdaw::AudioEngine& engine)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    engine.removeTrack(trackId);
}

void handleTrackGain(const juce::var& payload, jackdaw::AudioEngine& engine)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    const auto gain = static_cast<float>(static_cast<double>(payload.getProperty("gain", 1.0)));
    engine.setTrackGain(trackId, gain);
}

// Same wire-protocol convention as BridgeServer::broadcast: (type, payload) order is
// fixed by design, so the easily-swappable-parameters check is intentionally silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void dispatchBridgeMessage(const juce::String& type, const juce::var& payload, jackdaw::AudioEngine& engine,
                           jackdaw::BridgeServer& bridge)
{
    if (type == "CLIP_ADD")
    {
        handleClipAdd(payload, engine, bridge);
    }
    else if (type == "CLIP_MOVE")
    {
        handleClipMove(payload, engine);
    }
    else if (type == "TRANSPORT_PLAY")
    {
        engine.play();
    }
    else if (type == "TRANSPORT_PAUSE")
    {
        engine.pause();
    }
    else if (type == "TRANSPORT_STOP")
    {
        engine.stop();
    }
    else if (type == "TRANSPORT_SEEK")
    {
        const double positionMs = static_cast<double>(payload.getProperty("positionMs", 0.0));
        engine.setPositionMs(positionMs);
    }
    else if (type == "TRACK_REMOVE")
    {
        handleTrackRemove(payload, engine);
    }
    else if (type == "TRACK_GAIN")
    {
        handleTrackGain(payload, engine);
    }
    else
    {
        std::cerr << "[bridge] unhandled message type: " << type.toStdString() << '\n';
    }
}

// See note on `resolveBridgePort`: argv must remain a C-style array.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int runBackend(int argc, char* argv[])
{
    const juce::String banner = "Jackdaw Backend v0.1.0 - " + juce::SystemStats::getOperatingSystemName() + " (" +
                                juce::SystemStats::getCpuVendor() + ")";
    std::cout << banner.toStdString() << '\n';

    const int bridgePort = resolveBridgePort(argc, argv);

    // Initialises MessageManager, JUCE singletons, etc. Required even for headless apps.
    const juce::ScopedJuceInitialiser_GUI juceInit;

    jackdaw::AudioEngine engine;
    if (const auto err = engine.initialise(); err.isNotEmpty())
    {
        std::cerr << "[engine] audio device init failed: " << err.toStdString() << '\n';
        // Continue anyway - frontend can still load files, just won't hear anything.
    }

    jackdaw::BridgeServer bridge;

    // Route incoming messages from the bridge to the engine. Already on the
    // JUCE message thread (BridgeServer::onIncoming marshals via callAsync).
    bridge.onMessage([&engine, &bridge](const juce::String& type, const juce::var& payload)
                     { dispatchBridgeMessage(type, payload, engine, bridge); });

    if (!bridge.start(bridgePort))
    {
        std::cerr << "[bridge] failed to start; exiting\n";
        return 1;
    }

    PlayheadEmitter emitter(engine, bridge);
    emitter.startTimerHz(kPlayheadUpdateHz);

    // Catch Ctrl+C so the dispatch loop can exit cleanly.
    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    juce::MessageManager::getInstance()->runDispatchLoop();

    emitter.stopTimer();
    bridge.stop();
    engine.shutdown();
    std::cout << "[main] shutdown complete\n";
    return 0;
}
} // namespace

// The catch handler logs to std::cerr, which clang-tidy can't statically prove is
// non-throwing; in practice cerr won't throw without exceptions() being enabled.
// `argv` has to be a C-style array — only legal `main` signature.
// NOLINTNEXTLINE(bugprone-exception-escape,modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int main(int argc, char* argv[])
{
    try
    {
        return runBackend(argc, argv);
    }
    catch (const std::exception& e)
    {
        std::cerr << "[fatal] uncaught exception: " << e.what() << '\n';
        return 1;
    }
    catch (...)
    {
        std::cerr << "[fatal] uncaught non-standard exception\n";
        return 1;
    }
}
