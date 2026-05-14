cmake_minimum_required(VERSION 3.22)

project(JackdawBackend
    VERSION 0.1.0
    DESCRIPTION "Jackdaw headless audio backend"
    LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Export compile_commands.json for clangd / IntelliSense.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ─── JUCE ────────────────────────────────────────────────────────────────
# JUCE lives at the repo root as a git submodule (sibling of `backend/`).
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../JUCE JUCE)

# ─── Target ──────────────────────────────────────────────────────────────
juce_add_console_app(JackdawBackend
    PRODUCT_NAME "Jackdaw Backend"
    COMPANY_NAME "Jackdaw")

target_sources(JackdawBackend PRIVATE
    src/Main.cpp)

target_compile_definitions(JackdawBackend PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_STANDALONE_APPLICATION=1)

target_link_libraries(JackdawBackend PRIVATE
    juce::juce_core
    juce::juce_events
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)
