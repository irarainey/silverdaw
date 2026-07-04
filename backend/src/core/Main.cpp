#include "AudioEngine.h"
#include "AudioDeviceCommands.h"
#include "BridgeDispatch.h"
#include "BridgeServer.h"
#include "CrashHandler.h"
#include "DecodedCache.h"
#include "EditUndoState.h"
#include "Log.h"
#include "PeaksCache.h"
#include "PlayheadEmitter.h"
#include "ProjectSession.h"
#include "ProjectState.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iostream>
#include <juce_events/juce_events.h>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <thread>

// Entry point: bridge I/O and audio threads marshal engine mutations onto the JUCE message thread.
// NOTE: keep string literals ASCII-only; use juce::CharPointer_UTF8 for Unicode.

namespace
{
constexpr int kMinBridgePort = 1024;
constexpr int kMaxBridgePort = 65535;
constexpr int kPlayheadUpdateHz = 60;
// Peak jobs are disk-bound; four workers keep imports responsive without saturating cores.
constexpr int kPeakWorkerCount = 4;

std::atomic<bool> g_shouldQuit{false};

void onSignal(int /*sig*/)
{
    g_shouldQuit.store(true);
    juce::MessageManager::getInstance()->stopDispatchLoop();
}

// Strict port parsing keeps invalid dynamic-port setup debuggable.
int parsePort(std::string_view value, std::string_view source)
{
    if (value.empty())
    {
        silverdaw::log::warn("main",
                             juce::String("empty port value from ") + juce::String(std::string(source)));
        return -1;
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
        silverdaw::log::warn("main",
                             juce::String("invalid port from ") + juce::String(std::string(source)) + " (" +
                                 juce::String(std::string(value)) + "): " + juce::String(e.what()));
        return -1;
    }

    if (port < kMinBridgePort || port > kMaxBridgePort)
    {
        silverdaw::log::warn("main",
                             juce::String("port ") + juce::String(port) + " from " +
                                 juce::String(std::string(source)) + " outside [" +
                                 juce::String(kMinBridgePort) + ", " + juce::String(kMaxBridgePort) + "]");
        return -1;
    }

    return port;
}

// Electron owns dynamic port selection; missing/invalid `--port` is a startup error.
// `argv` must remain a C-style array for main-compatible helpers.
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

    silverdaw::log::error("main",
                          juce::String("missing required --port <N> argument (range [") +
                              juce::String(kMinBridgePort) + ", " + juce::String(kMaxBridgePort) +
                              "]); refusing to start");
    return -1;
}

// Prefer Electron's per-session env token; CLI token exists only for manual backend testing.
// `argv` must remain a C-style array for main-compatible helpers.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
juce::String resolveBridgeToken(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string_view arg{argv[i]};
        if (arg == "--token" && i + 1 < argc)
        {
            return juce::String{argv[i + 1]};
        }
        constexpr std::string_view prefix = "--token=";
        if (arg.size() > prefix.size() && arg.substr(0, prefix.size()) == prefix)
        {
            return juce::String{std::string(arg.substr(prefix.size()))};
        }
    }

    return juce::SystemStats::getEnvironmentVariable("SILVERDAW_BRIDGE_TOKEN", {});
}


// `argv` must remain a C-style array for main-compatible helpers.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int runBackend(int argc, char* argv[])
{
    // Two log sinks, both resolved up front:
    //  - SILVERDAW_LOG_DIR: opt-in verbose session log (all levels), only set when
    //    the user enables diagnostic logging in Preferences.
    //  - SILVERDAW_DIAG_DIR: an ALWAYS-ON diagnostics dir the frontend passes on
    //    every launch. Used for the crash report and, when verbose logging is off,
    //    for an INFO-level startup log — so a failed/crashed startup on a machine
    //    we can't attach to still leaves an easy-to-find trace regardless of the
    //    user's logging preference.
    const auto logDirOverride = juce::SystemStats::getEnvironmentVariable("SILVERDAW_LOG_DIR", {});
    const auto diagDir = juce::SystemStats::getEnvironmentVariable("SILVERDAW_DIAG_DIR", {});

    // Install the crash reporter first, so a fault anywhere below is captured.
    silverdaw::crash::install(diagDir.isNotEmpty() ? diagDir : logDirOverride);
    silverdaw::crash::setPhase("startup");

    if (logDirOverride.isNotEmpty())
    {
        silverdaw::log::initialise(logDirOverride);
    }
    else if (diagDir.isNotEmpty())
    {
        // Always-on but startup-scoped: INFO+ (no per-frame DEBUG), truncated each
        // launch, and closed once startup succeeds (see markStartupComplete). It
        // exists only to diagnose a backend that can't start — ongoing session
        // logging is the opt-in verbose sink's job.
        silverdaw::log::initialise(diagDir, silverdaw::log::Level::Info, /*truncate*/ true,
                                   /*startupOnly*/ true);
    }

    const juce::String banner = "Silverdaw Backend v1.0.0 - " + juce::SystemStats::getOperatingSystemName() + " (" +
                                juce::SystemStats::getCpuVendor() + ")";
    std::cout << banner.toStdString() << '\n';
    silverdaw::log::info("main", banner);

    const int bridgePort = resolveBridgePort(argc, argv);
    if (bridgePort < 0)
    {
        // Also print to stderr because file logging may be disabled.
        std::cerr << "[main] missing or invalid --port; expected: " << argv[0]
                  << " --port <" << kMinBridgePort << "-" << kMaxBridgePort << ">\n";
        return 2;
    }
    const juce::String bridgeToken = resolveBridgeToken(argc, argv);

    // Verbose, always-on startup diagnostics: enough to triage a slow or failed launch
    // from the log alone (no repro). One-shot, INFO-level; the diag log is startup-scoped.
    silverdaw::log::info("sys",
                         "JUCE " + juce::SystemStats::getJUCEVersion() + " | OS "
                             + juce::SystemStats::getOperatingSystemName()
                             + (juce::SystemStats::isOperatingSystem64Bit() ? " (64-bit)" : " (32-bit)"));
    silverdaw::log::info("sys",
                         "CPU " + juce::SystemStats::getCpuModel() + " ["
                             + juce::SystemStats::getCpuVendor() + "] "
                             + juce::String(juce::SystemStats::getNumCpus()) + " logical / "
                             + juce::String(juce::SystemStats::getNumPhysicalCpus()) + " physical @ "
                             + juce::String(juce::SystemStats::getCpuSpeedInMegahertz()) + " MHz | RAM "
                             + juce::String(juce::SystemStats::getMemorySizeInMegabytes()) + " MB");
    silverdaw::log::info("main",
                         "port=" + juce::String(bridgePort) + " token="
                             + (bridgeToken.isNotEmpty() ? "set" : "unset") + " diagDir="
                             + (diagDir.isNotEmpty() ? diagDir : juce::String("(none)")) + " logDir="
                             + (logDirOverride.isNotEmpty() ? logDirOverride : juce::String("(off)")));
    silverdaw::log::info("main",
                         "exe=" + juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName()
                             + " cwd=" + juce::File::getCurrentWorkingDirectory().getFullPathName());

    // Required even for headless JUCE apps.
    const juce::ScopedJuceInitialiser_GUI juceInit;

    // Fast, device-independent graph setup so the bridge can start and the UI can appear
    // before the (possibly slow) audio device open. The device is opened AFTER the bridge is
    // serving (see below), so a slow cold-start endpoint no longer blocks connectivity.
    silverdaw::crash::setPhase("audio-graph-init");
    silverdaw::AudioEngine engine;
    engine.initialiseGraph();
    const auto preferredAudioTypeName =
        juce::SystemStats::getEnvironmentVariable("SILVERDAW_OUTPUT_DEVICE_TYPE", {});
    const auto preferredAudioDeviceName =
        juce::SystemStats::getEnvironmentVariable("SILVERDAW_OUTPUT_DEVICE_NAME", {});
    silverdaw::log::info("audio",
                         "preferred output: type='" + preferredAudioTypeName + "' name='"
                             + preferredAudioDeviceName + "'"
                             + (preferredAudioTypeName.isEmpty() && preferredAudioDeviceName.isEmpty()
                                    ? " (system default)"
                                    : ""));

    silverdaw::ProjectState projectState;
    silverdaw::ProjectSession session;

    // Disk-backed peaks cache avoids recomputing the same file across reloads.
    const silverdaw::PeaksCache peaksCache;

    // Disk-backed decoded cache avoids repeated compressed-audio decode on clip add.
    const silverdaw::DecodedCache decodedCache;

    if (bridgeToken.isEmpty())
    {
        silverdaw::log::warn("bridge",
                             "WARNING: no AUTH token set (SILVERDAW_BRIDGE_TOKEN unset and --token not given); "
                             "accepting all loopback clients. DO NOT USE IN PRODUCTION.");
    }

    // Declared before `bridge` so captured references outlive worker jobs.
    juce::ThreadPool peakPool(kPeakWorkerCount);

    // Freeze bridge callbacks at construction so I/O-thread reads are race-free.
    silverdaw::BridgeServer bridge(
        bridgeToken,
        [&engine, &projectState, &peakPool, &peaksCache, &decodedCache, &session](
            silverdaw::BridgeServer& self, const juce::String& type, const juce::var& payload)
        {
            // Message-thread crash firewall: prefer an ENGINE_ERROR over a dead backend.
            try
            {
                silverdaw::dispatchBridgeMessage(type, payload, engine, projectState, self, peakPool,
                                                 peaksCache, decodedCache, session);
            }
            catch (const std::exception& e)
            {
                silverdaw::log::error("bridge", "handler threw for type=" + type + ": " +
                                                    juce::String(e.what()) + " — engine kept alive");
                auto* p = new juce::DynamicObject();
                p->setProperty("message", juce::String(e.what()));
                p->setProperty("context", type);
                self.broadcast("ENGINE_ERROR", juce::var(p));
            }
            catch (...)
            {
                silverdaw::log::error("bridge",
                                      "handler threw unknown exception for type=" + type + " — engine kept alive");
                auto* p = new juce::DynamicObject();
                p->setProperty("message", juce::String("Unknown engine error"));
                p->setProperty("context", type);
                self.broadcast("ENGINE_ERROR", juce::var(p));
            }
        },
        [&projectState, &session](const silverdaw::BridgeServer::SendToClient& sendToClient)
        {
            // Target only the new client; existing clients already have their snapshots.
            sendToClient("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
            // Seed menu state before first paint.
            sendToClient("EDIT_UNDO_STATE", silverdaw::buildEditUndoStateEnvelope(projectState));
        });

    silverdaw::crash::setPhase("bridge-start");
    if (!bridge.start(bridgePort))
    {
        silverdaw::log::error("bridge", "failed to start; exiting");
        return 1;
    }

    // Dirty broadcasts mirror message-thread ValueTree mutations to renderer chrome.
    projectState.setDirtyChangedCallback(
        [&bridge](bool dirty)
        {
            auto* p = new juce::DynamicObject();
            p->setProperty("dirty", dirty);
            bridge.broadcast("PROJECT_DIRTY", juce::var(p));
        });

    // Re-broadcast device changes after the engine snapshot/fallback is already updated.
    engine.setDeviceListChangedCallback(
        [&bridge, &engine]()
        {
            silverdaw::broadcastAudioDevicesList(bridge,
                                      silverdaw::buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot()),
                                      /*dedupe*/ true);
        });

    // Open the audio device now that the bridge is serving. The renderer has already
    // connected and received READY on the I/O thread, so this (potentially slow cold-start)
    // open no longer blocks the UI from appearing. It runs on the message thread before the
    // dispatch loop, so PROJECT_STATE — which flips the renderer's bridgeReady — is delivered
    // immediately after the device is ready. A failed open is non-fatal (logged); the engine
    // stays alive and the app remains usable without audio output.
    silverdaw::crash::setPhase("audio-device-init");
    if (const auto err = engine.openAudioDevice(preferredAudioTypeName, preferredAudioDeviceName);
        err.isNotEmpty())
    {
        silverdaw::log::error("engine", "audio device open failed: " + err);
    }
    silverdaw::broadcastAudioDevicesList(
        bridge, silverdaw::buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot()), /*dedupe*/ false);

    silverdaw::PlayheadEmitter emitter(engine, bridge);
    emitter.startTimerHz(kPlayheadUpdateHz);

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    silverdaw::crash::setPhase("running");
    // Startup succeeded: close the always-on diagnostics log so it never grows with
    // runtime logging. A later crash is still captured by the crash reporter.
    silverdaw::log::markStartupComplete();
    juce::MessageManager::getInstance()->runDispatchLoop();

    // Drain worker jobs before captured bridge/cache/engine references destruct.
    peakPool.removeAllJobs(false, 5000);

    emitter.stopTimer();
    bridge.stop();
    engine.shutdown();
    silverdaw::log::info("main", "shutdown complete");
    silverdaw::log::shutdown();
    std::cout << "[main] shutdown complete\n";
    return 0;
}
} // namespace

// `argv` must be a C-style array; `cerr` is non-throwing unless exceptions are enabled.
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
