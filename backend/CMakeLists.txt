cmake_minimum_required(VERSION 3.22)

project(SilverdawBackend
    VERSION 1.0.0
    DESCRIPTION "Silverdaw headless audio backend"
    LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Export compile_commands.json for clangd / IntelliSense.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ─── JUCE ────────────────────────────────────────────────────────────────
# JUCE is fetched at configure time. The first configure downloads ~250MB
# into `backend/build/_deps/juce-src/`; subsequent configures are cached.
# Bump JUCE_GIT_TAG to update the pinned version.
set(JUCE_GIT_TAG "8.0.12" CACHE STRING "JUCE version to fetch")

include(FetchContent)
FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        ${JUCE_GIT_TAG}
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE)
FetchContent_MakeAvailable(JUCE)

# ─── IXWebSocket ─────────────────────────────────────────────────────────
# Local-only WebSocket bridge between the JUCE backend and the Electron
# renderer. TLS + zlib are disabled — we only ever talk to ws://localhost.
set(IXWEBSOCKET_GIT_TAG "v11.4.5" CACHE STRING "IXWebSocket version to fetch")
set(USE_TLS OFF CACHE BOOL "" FORCE)
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(USE_OPEN_SSL OFF CACHE BOOL "" FORCE)
set(USE_MBED_TLS OFF CACHE BOOL "" FORCE)

FetchContent_Declare(IXWebSocket
    GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
    GIT_TAG        ${IXWEBSOCKET_GIT_TAG}
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE)
FetchContent_MakeAvailable(IXWebSocket)

# ─── Target ──────────────────────────────────────────────────────────────
juce_add_console_app(SilverdawBackend
    PRODUCT_NAME "Silverdaw Backend"
    COMPANY_NAME "Silverdaw")

target_sources(SilverdawBackend PRIVATE
    src/Main.cpp
    src/AudioEngine.cpp
    src/BridgeServer.cpp
    src/Log.cpp
    src/PeaksCache.cpp
    src/ProjectState.cpp
    src/Waveform.cpp)

target_compile_definitions(SilverdawBackend PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=1
    JUCE_STANDALONE_APPLICATION=1)

target_link_libraries(SilverdawBackend PRIVATE
    juce::juce_core
    juce::juce_events
    juce::juce_data_structures
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_audio_utils
    ixwebsocket
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)
