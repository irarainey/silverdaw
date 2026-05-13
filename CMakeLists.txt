cmake_minimum_required(VERSION 3.22)

project(Jackdaw
    VERSION 0.1.0
    DESCRIPTION "Jackdaw — a digital audio workstation"
    LANGUAGES CXX C
)

# ---------------------------------------------------------------------------
# Global settings
# ---------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Put all binaries in a predictable location so Visual Studio finds them
# regardless of the active configuration.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")

# Enable folder grouping in Visual Studio so the JUCE modules appear neatly
# under their own folder rather than polluting the solution root.
set_property(GLOBAL PROPERTY USE_FOLDERS YES)

# ---------------------------------------------------------------------------
# Fetch JUCE
# ---------------------------------------------------------------------------
# We pin JUCE to a known-good tag. Update this deliberately, not accidentally.
include(FetchContent)

FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.4
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE
)
FetchContent_MakeAvailable(JUCE)

# ---------------------------------------------------------------------------
# The Jackdaw application target
# ---------------------------------------------------------------------------
juce_add_gui_app(Jackdaw
    PRODUCT_NAME            "Jackdaw"
    COMPANY_NAME            "Jackdaw"
    BUNDLE_ID               "com.jackdaw.app"
    VERSION                 "${PROJECT_VERSION}"
    ICON_BIG                ""    # add an icon file path here later
    MICROPHONE_PERMISSION_ENABLED TRUE
)

# Generate the JuceHeader.h convenience header so we can `#include <JuceHeader.h>`.
juce_generate_juce_header(Jackdaw)

target_sources(Jackdaw
    PRIVATE
        Source/Main.cpp
        Source/MainComponent.cpp
        Source/MainComponent.h
        Source/Track.cpp
        Source/Track.h
        Source/TrackMixerSource.cpp
        Source/TrackMixerSource.h
        Source/TrackControls.cpp
        Source/TrackControls.h
        Source/TrackLane.cpp
        Source/TrackLane.h
        Source/TimeRuler.cpp
        Source/TimeRuler.h
)

target_compile_definitions(Jackdaw
    PRIVATE
        # Disable JUCE's auto-splash / reporting in the executable.
        JUCE_DISPLAY_SPLASH_SCREEN=0
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        # Project-level metadata that JUCE picks up at build time.
        JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Jackdaw,JUCE_PRODUCT_NAME>"
        JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Jackdaw,JUCE_VERSION>"
)

target_link_libraries(Jackdaw
    PRIVATE
        juce::juce_audio_utils       # AudioThumbnail, AudioDeviceSelectorComponent
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_audio_processors
        juce::juce_audio_basics
        juce::juce_gui_extra
        juce::juce_gui_basics
        juce::juce_graphics
        juce::juce_events
        juce::juce_core
        juce::juce_data_structures
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags
)

# Make the executable the Visual Studio "startup" project so F5 just works.
set_property(DIRECTORY "${CMAKE_SOURCE_DIR}" PROPERTY VS_STARTUP_PROJECT Jackdaw)
