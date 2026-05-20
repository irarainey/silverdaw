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

# ─── libsamplerate ───────────────────────────────────────────────────────
# BTrack (below) needs a sample-rate converter to resample its onset-
# detection function. We use the upstream `libsamplerate` library
# (BSD-2-Clause) fetched at configure time so there's no system
# dependency to manage on Windows.
set(LIBSAMPLERATE_GIT_TAG "0.2.2" CACHE STRING "libsamplerate version to fetch")
set(LIBSAMPLERATE_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LIBSAMPLERATE_INSTALL OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
# Newer CMake (>= 4) refuses to build projects whose
# `cmake_minimum_required` is below 3.5 — libsamplerate 0.2.2 still
# uses an older floor. This policy override lets it configure with
# modern CMake without forking the upstream source.
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)

FetchContent_Declare(libsamplerate
    GIT_REPOSITORY https://github.com/libsndfile/libsamplerate.git
    GIT_TAG        ${LIBSAMPLERATE_GIT_TAG}
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE)
FetchContent_MakeAvailable(libsamplerate)

# ─── BTrack (BPM + beat tracking) ────────────────────────────────────────
# We vendor a patched copy of BTrack under `backend/third_party/btrack/`:
# the upstream sources use VLAs (a GCC extension MSVC rejects) and rely
# on the non-portable `M_PI` macro. The patches (documented at the top of
# `BTrack.cpp`) replace the VLAs with `std::vector` and add
# `#define _USE_MATH_DEFINES`. The KISS FFT backend is used (BSD-licensed,
# also vendored) so there's no FFTW dependency.
set(BTRACK_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/btrack)
add_library(btrack_local STATIC
    ${BTRACK_DIR}/BTrack.cpp
    ${BTRACK_DIR}/OnsetDetectionFunction.cpp
    ${BTRACK_DIR}/kiss_fft130/kiss_fft.c)
target_include_directories(btrack_local PUBLIC
    ${BTRACK_DIR}
    ${BTRACK_DIR}/kiss_fft130)
target_compile_definitions(btrack_local PUBLIC USE_KISS_FFT)
# Silence MSVC's "unsafe" warnings inside BTrack's third-party code so
# we don't drown out our own warnings.
if(MSVC)
    target_compile_options(btrack_local PRIVATE /W0 /wd4267 /wd4244)
endif()
target_link_libraries(btrack_local PRIVATE SampleRate::samplerate)

option(SILVERDAW_BUILD_TESTS "Build backend unit tests" OFF)
option(SILVERDAW_ENABLE_COVERAGE "Instrument backend unit tests for code coverage" OFF)

if(SILVERDAW_ENABLE_COVERAGE AND NOT SILVERDAW_BUILD_TESTS)
    message(FATAL_ERROR "SILVERDAW_ENABLE_COVERAGE requires SILVERDAW_BUILD_TESTS=ON")
endif()

add_library(silverdaw_backend_core STATIC
    src/AudioEngine.cpp
    src/BridgeAuth.cpp
    src/BpmDetector.cpp
    src/BridgeServer.cpp
    src/DecodedCache.cpp
    src/Log.cpp
    src/PeaksCache.cpp
    src/ProjectFile.cpp
    src/ProjectState.cpp
    src/ValueTreeJson.cpp
    src/Waveform.cpp)

target_compile_definitions(silverdaw_backend_core PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=1
    JUCE_STANDALONE_APPLICATION=1)

target_include_directories(silverdaw_backend_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_link_libraries(silverdaw_backend_core PUBLIC
    juce::juce_core
    juce::juce_events
    juce::juce_data_structures
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_audio_utils
    ixwebsocket
    btrack_local
    SampleRate::samplerate
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

if(SILVERDAW_ENABLE_COVERAGE)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        target_compile_options(silverdaw_backend_core PRIVATE
            -O0 -g -fprofile-instr-generate -fcoverage-mapping)
    elseif(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
        target_compile_options(silverdaw_backend_core PRIVATE
            -O0 -g --coverage)
    else()
        message(FATAL_ERROR
            "Backend coverage requires a Clang or GNU compiler. "
            "The current compiler is ${CMAKE_CXX_COMPILER_ID}.")
    endif()
endif()

# ─── Target ──────────────────────────────────────────────────────────────
juce_add_console_app(SilverdawBackend
    PRODUCT_NAME "Silverdaw Backend"
    COMPANY_NAME "Silverdaw")

target_sources(SilverdawBackend PRIVATE
    src/Main.cpp)

target_link_libraries(SilverdawBackend PRIVATE
    silverdaw_backend_core)

if(SILVERDAW_BUILD_TESTS)
    enable_testing()

    add_executable(SilverdawBackendTests
        tests/BackendTests.cpp)
    target_link_libraries(SilverdawBackendTests PRIVATE
        silverdaw_backend_core)

    if(SILVERDAW_ENABLE_COVERAGE)
        set(SILVERDAW_BACKEND_COVERAGE_DIR ${CMAKE_BINARY_DIR}/coverage)
        if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
            target_compile_options(SilverdawBackendTests PRIVATE
                -O0 -g -fprofile-instr-generate -fcoverage-mapping)
            target_link_options(SilverdawBackendTests PRIVATE
                -fprofile-instr-generate -fcoverage-mapping)
            find_program(LLVM_PROFDATA_EXE llvm-profdata)
            find_program(LLVM_COV_EXE llvm-cov)
            if(LLVM_PROFDATA_EXE AND LLVM_COV_EXE)
                add_custom_target(SilverdawBackendCoverage
                    COMMAND ${CMAKE_COMMAND} -E make_directory ${SILVERDAW_BACKEND_COVERAGE_DIR}/html
                    COMMAND ${CMAKE_COMMAND} -E env
                        LLVM_PROFILE_FILE=${SILVERDAW_BACKEND_COVERAGE_DIR}/backend.profraw
                        $<TARGET_FILE:SilverdawBackendTests>
                    COMMAND ${LLVM_PROFDATA_EXE} merge -sparse
                        ${SILVERDAW_BACKEND_COVERAGE_DIR}/backend.profraw
                        -o ${SILVERDAW_BACKEND_COVERAGE_DIR}/backend.profdata
                    COMMAND ${LLVM_COV_EXE} report
                        $<TARGET_FILE:SilverdawBackendTests>
                        -instr-profile=${SILVERDAW_BACKEND_COVERAGE_DIR}/backend.profdata
                        "-ignore-filename-regex=.*[/\\\\](_deps|third_party|tests)[/\\\\].*"
                    COMMAND ${LLVM_COV_EXE} show
                        $<TARGET_FILE:SilverdawBackendTests>
                        -instr-profile=${SILVERDAW_BACKEND_COVERAGE_DIR}/backend.profdata
                        -format=html
                        -output-dir=${SILVERDAW_BACKEND_COVERAGE_DIR}/html
                        "-ignore-filename-regex=.*[/\\\\](_deps|third_party|tests)[/\\\\].*"
                    DEPENDS SilverdawBackendTests
                    COMMENT "Running backend tests with LLVM coverage")
            else()
                message(WARNING "llvm-profdata and llvm-cov are required for SilverdawBackendCoverage")
            endif()
        elseif(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
            target_compile_options(SilverdawBackendTests PRIVATE
                -O0 -g --coverage)
            target_link_options(SilverdawBackendTests PRIVATE
                --coverage)
            find_program(GCOVR_EXE gcovr)
            if(GCOVR_EXE)
                add_custom_target(SilverdawBackendCoverage
                    COMMAND ${CMAKE_COMMAND} -E make_directory ${SILVERDAW_BACKEND_COVERAGE_DIR}
                    COMMAND $<TARGET_FILE:SilverdawBackendTests>
                    COMMAND ${GCOVR_EXE}
                        -r ${CMAKE_CURRENT_SOURCE_DIR}
                        --filter ${CMAKE_CURRENT_SOURCE_DIR}/src
                        --exclude ${CMAKE_CURRENT_SOURCE_DIR}/third_party
                        --exclude ${CMAKE_CURRENT_SOURCE_DIR}/tests
                        --txt
                        --html-details
                        -o ${SILVERDAW_BACKEND_COVERAGE_DIR}/index.html
                    DEPENDS SilverdawBackendTests
                    COMMENT "Running backend tests with gcovr coverage")
            else()
                message(WARNING "gcovr is required for SilverdawBackendCoverage")
            endif()
        endif()
    endif()

    add_test(NAME SilverdawBackendTests COMMAND SilverdawBackendTests)
endif()
