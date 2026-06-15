cmake_minimum_required(VERSION 3.22)

if(POLICY CMP0091)
    cmake_policy(SET CMP0091 NEW)
endif()

project(SilverdawBackend
    VERSION 1.0.0
    DESCRIPTION "Silverdaw headless audio backend"
    LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
    # The Electron/NSIS installer does not bootstrap the Visual C++
    # Redistributable. Link the backend against the static MSVC runtime
    # so clean Windows installs don't fail to spawn SilverdawBackend.exe
    # due to missing MSVCP140/VCRUNTIME DLLs.
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

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

# ─── Rubber Band Library (time-stretch + pitch-shift) ────────────────────
# Rubber Band ships a Meson-only build; there's no upstream CMake target.
# We FetchContent the source tree (downloads only, no add_subdirectory) and
# build it ourselves as a static library with the KissFFT backend (also
# vendored inside the Rubber Band source under `src/ext/kissfft/`) and
# libsamplerate for the resampling stage. That's exactly the FFT + SRC
# pair BTrack already uses, so we don't pick up any new transitive
# dependencies for the warp engine.
#
# Licence: Rubber Band Library is GPL-2.0+. Silverdaw ships under
# AGPL-3.0+, which is GPL-2.0+ compatible (per the AGPL §13 / GPL §6
# relicensing clauses), so we can link statically without further
# action; the upstream `COPYING` lives at `_deps/rubberband-src/COPYING`
# and is picked up by the THIRD_PARTY_LICENSES.md aggregation step.
set(RUBBERBAND_GIT_TAG "v3.3.0" CACHE STRING "Rubber Band Library version to fetch")

FetchContent_Declare(rubberband
    GIT_REPOSITORY https://github.com/breakfastquay/rubberband.git
    GIT_TAG        ${RUBBERBAND_GIT_TAG}
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE)
# Populate-only: do NOT call FetchContent_MakeAvailable — Rubber Band has
# no CMakeLists.txt and would fail the add_subdirectory pass.
FetchContent_GetProperties(rubberband)
if(NOT rubberband_POPULATED)
    FetchContent_Populate(rubberband)
endif()

set(RB_DIR ${rubberband_SOURCE_DIR})

# Rubber Band v3.3.0 has a stray `#include "system/sysutils.h"` in
# `src/common/VectorOpsComplex.cpp` — the actual header lives at
# `src/common/sysutils.h` and no `system/` directory exists on disk.
# Confirmed against an upstream checkout; almost certainly a typo from
# a half-finished directory rename. Rather than patch the upstream
# source, generate a one-line shim header in the build directory and
# put it on the include path so the broken include resolves cleanly.
set(RB_SHIM_DIR ${CMAKE_CURRENT_BINARY_DIR}/rubberband_shims)
file(WRITE ${RB_SHIM_DIR}/system/sysutils.h
    "// Shim generated by Silverdaw's CMake build to work around an\n"
    "// upstream include typo in Rubber Band v3.3.0 — see backend/CMakeLists.txt.\n"
    "#pragma once\n"
    "#include \"common/sysutils.h\"\n")

add_library(rubberband_local STATIC
    ${RB_DIR}/src/RubberBandStretcher.cpp
    ${RB_DIR}/src/common/Allocators.cpp
    ${RB_DIR}/src/common/BQResampler.cpp
    ${RB_DIR}/src/common/FFT.cpp
    ${RB_DIR}/src/common/Log.cpp
    ${RB_DIR}/src/common/mathmisc.cpp
    ${RB_DIR}/src/common/Profiler.cpp
    ${RB_DIR}/src/common/Resampler.cpp
    ${RB_DIR}/src/common/StretchCalculator.cpp
    ${RB_DIR}/src/common/sysutils.cpp
    ${RB_DIR}/src/common/Thread.cpp
    ${RB_DIR}/src/common/VectorOpsComplex.cpp
    ${RB_DIR}/src/faster/AudioCurveCalculator.cpp
    ${RB_DIR}/src/faster/CompoundAudioCurve.cpp
    ${RB_DIR}/src/faster/HighFrequencyAudioCurve.cpp
    ${RB_DIR}/src/faster/PercussiveAudioCurve.cpp
    ${RB_DIR}/src/faster/R2Stretcher.cpp
    ${RB_DIR}/src/faster/SilentAudioCurve.cpp
    ${RB_DIR}/src/faster/StretcherChannelData.cpp
    ${RB_DIR}/src/faster/StretcherProcess.cpp
    ${RB_DIR}/src/finer/R3Stretcher.cpp
    ${RB_DIR}/src/ext/kissfft/kiss_fft.c
    ${RB_DIR}/src/ext/kissfft/kiss_fftr.c)
target_include_directories(rubberband_local PUBLIC
    ${RB_DIR}
    ${RB_DIR}/rubberband
    ${RB_DIR}/src
    ${RB_SHIM_DIR})
target_include_directories(rubberband_local PRIVATE
    ${RB_DIR}/src/ext/kissfft)
target_compile_definitions(rubberband_local PUBLIC
    # Use the vendored KissFFT for all FFT work; matches the BTrack
    # build's FFT choice so the two libraries share the same lineage.
    HAVE_KISSFFT
    # Use libsamplerate (already linked via SampleRate::samplerate) for
    # the resampler path. Without this, Rubber Band falls back to its
    # own BQResampler.
    HAVE_LIBSAMPLERATE
    # Stop windows.h from defining `min` / `max` as preprocessor macros
    # — Rubber Band's `finer/Guide.h` calls `std::min(...)` /
    # `std::max(...)`, and the macro expansion shreds the call site
    # ("error C2589: '(': illegal token on right side of '::'"). The
    # define is one-time, picked up by every Windows-API include
    # transitively pulled in by Rubber Band's source files.
    NOMINMAX
    # Disable Rubber Band's internal asserts in release builds — the
    # library is mature and the per-process-call asserts are noticeable
    # at warp-engine block sizes.
    NDEBUG_RUBBERBAND)
# Rubber Band's source liberally uses ints in size-comparison contexts;
# MSVC's signed/unsigned warnings would flood the build with noise from a
# third-party library we don't control. The pattern matches BTrack's
# treatment above.
if(MSVC)
    target_compile_options(rubberband_local PRIVATE
        /W0 /wd4267 /wd4244 /wd4305 /wd4018 /wd4146 /wd4715)
endif()
target_link_libraries(rubberband_local PUBLIC SampleRate::samplerate)

# ─── ONNX Runtime (stem separation inference) ────────────────────────────
# Phase 6 stem separation runs a Demucs model through ONNX Runtime. Microsoft
# ships official prebuilt Windows binaries, so rather than vendor a DLL by hand
# we FetchContent the prebuilt release archive at configure time — the same
# "every dependency is pulled in through CMake" approach used for JUCE,
# IXWebSocket and Rubber Band above. The archive carries the headers, an MSVC
# import library and the runtime DLL; we expose them through an IMPORTED target
# and copy the DLL next to SilverdawBackend.exe so it ships inside the installer
# (see the extraResources filter in `frontend/electron-builder.yml`).
#
# Licence: ONNX Runtime is MIT-licensed (the archive's `LICENSE` lands at
# `_deps/onnxruntime-src/LICENSE`, picked up by the THIRD_PARTY_LICENSES.md
# aggregation step), so redistributing the DLL alongside the app is permitted.
option(SILVERDAW_ENABLE_STEM_SEPARATION
    "Fetch ONNX Runtime and build the stem-separation engine" ON)

# GPU acceleration for stem separation via the DirectML execution provider.
# ON by default on Windows x64: the DirectML "superset" ONNX Runtime runs on the
# CPU *and* any DirectX 12 GPU from a single bundled onnxruntime.dll, so one
# build serves every machine — GPU when present (gated by detection), CPU
# otherwise. It is sourced from NuGet (the DirectML EP is not in the GitHub CPU
# release) and ships DirectML.dll alongside the executable. Set this OFF to build
# against the CPU-only GitHub ONNX Runtime instead (no GPU support, no
# DirectML.dll). The same .onnx weights run on either, so there is no
# GPU-specific model. GPU acceleration must be validated on real GPU hardware.
option(SILVERDAW_ONNXRUNTIME_DIRECTML
    "Build stem separation against a DirectML-capable ONNX Runtime (GPU)" ON)

if(SILVERDAW_ENABLE_STEM_SEPARATION AND NOT (WIN32 AND CMAKE_SIZEOF_VOID_P EQUAL 8))
    message(WARNING
        "Stem separation currently consumes the win-x64 ONNX Runtime build; "
        "disabling SILVERDAW_ENABLE_STEM_SEPARATION on this platform.")
    set(SILVERDAW_ENABLE_STEM_SEPARATION OFF CACHE BOOL "" FORCE)
endif()

if(SILVERDAW_ENABLE_STEM_SEPARATION)
    if(SILVERDAW_ONNXRUNTIME_DIRECTML)
        # GPU build: the DirectML execution provider ships only in the NuGet
        # ONNX Runtime, which tops out a couple of minor versions behind the
        # GitHub CPU release. This single "superset" onnxruntime.dll runs on the
        # CPU *and* any DirectX 12 GPU (the DML EP is compiled into it), so the
        # same .onnx weights work either way — no GPU-specific model. NuGet
        # packages are plain zips, so FetchContent extracts them like any archive.
        # The DML EP has a runtime dependency on DirectML.dll (from the separate
        # Microsoft.AI.DirectML package), which is copied next to the executable.
        set(ORT_DML_VERSION "1.24.4"
            CACHE STRING "Microsoft.ML.OnnxRuntime.DirectML NuGet version")
        set(ORT_DML_SHA256
            "57e9f11b73437bef7a309496135d4c1f96b1a8e9ddba60013fa27bfc1d788681"
            CACHE STRING "SHA-256 of the ORT DirectML .nupkg")
        set(DIRECTML_VERSION "1.15.4"
            CACHE STRING "Microsoft.AI.DirectML NuGet version (ORT DML dependency)")
        set(DIRECTML_SHA256
            "4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9"
            CACHE STRING "SHA-256 of the Microsoft.AI.DirectML .nupkg")

        FetchContent_Declare(onnxruntime_dml
            URL https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/${ORT_DML_VERSION}/microsoft.ml.onnxruntime.directml.${ORT_DML_VERSION}.nupkg
            URL_HASH SHA256=${ORT_DML_SHA256}
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
        FetchContent_GetProperties(onnxruntime_dml)
        if(NOT onnxruntime_dml_POPULATED)
            FetchContent_Populate(onnxruntime_dml)
        endif()

        FetchContent_Declare(directml
            URL https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/${DIRECTML_VERSION}/microsoft.ai.directml.${DIRECTML_VERSION}.nupkg
            URL_HASH SHA256=${DIRECTML_SHA256}
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
        FetchContent_GetProperties(directml)
        if(NOT directml_POPULATED)
            FetchContent_Populate(directml)
        endif()

        set(ORT_INCLUDE_DIR "${onnxruntime_dml_SOURCE_DIR}/build/native/include")
        set(ORT_LIB "${onnxruntime_dml_SOURCE_DIR}/runtimes/win-x64/native/onnxruntime.lib")
        set(SILVERDAW_ONNXRUNTIME_DLL
            "${onnxruntime_dml_SOURCE_DIR}/runtimes/win-x64/native/onnxruntime.dll"
            CACHE FILEPATH "Path to the bundled onnxruntime.dll" FORCE)
        set(SILVERDAW_DIRECTML_DLL "${directml_SOURCE_DIR}/bin/x64-win/DirectML.dll"
            CACHE FILEPATH "Path to the bundled DirectML.dll" FORCE)
    else()
        # CPU build (default): the official ONNX Runtime win-x64 release archive.
        set(ONNXRUNTIME_VERSION "1.26.0"
            CACHE STRING "ONNX Runtime version to fetch")
        # SHA-256 of onnxruntime-win-x64-${ONNXRUNTIME_VERSION}.zip. Bump alongside
        # ONNXRUNTIME_VERSION; the integrity check makes the fetch reproducible.
        set(ONNXRUNTIME_SHA256
            "6ebe99b5564bf4d029b6e93eac9ff423682b6212eade769e9ca3f685eaf500b4"
            CACHE STRING "SHA-256 of the ONNX Runtime win-x64 release archive")

        FetchContent_Declare(onnxruntime
            URL https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-win-x64-${ONNXRUNTIME_VERSION}.zip
            URL_HASH SHA256=${ONNXRUNTIME_SHA256}
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
        # Prebuilt binary distribution — no CMakeLists, so populate only (mirrors
        # the Rubber Band block above; FetchContent_MakeAvailable would try to
        # add_subdirectory and fail).
        FetchContent_GetProperties(onnxruntime)
        if(NOT onnxruntime_POPULATED)
            FetchContent_Populate(onnxruntime)
        endif()

        set(ORT_INCLUDE_DIR "${onnxruntime_SOURCE_DIR}/include")
        set(ORT_LIB "${onnxruntime_SOURCE_DIR}/lib/onnxruntime.lib")
        set(SILVERDAW_ONNXRUNTIME_DLL "${onnxruntime_SOURCE_DIR}/lib/onnxruntime.dll"
            CACHE FILEPATH "Path to the bundled onnxruntime.dll" FORCE)
    endif()

    add_library(onnxruntime SHARED IMPORTED GLOBAL)
    set_target_properties(onnxruntime PROPERTIES
        IMPORTED_LOCATION "${SILVERDAW_ONNXRUNTIME_DLL}"
        IMPORTED_IMPLIB   "${ORT_LIB}"
        INTERFACE_INCLUDE_DIRECTORIES "${ORT_INCLUDE_DIR}")
endif()

option(SILVERDAW_BUILD_TESTS "Build backend unit tests" OFF)
option(SILVERDAW_ENABLE_COVERAGE "Instrument backend unit tests for code coverage" OFF)

if(SILVERDAW_ENABLE_COVERAGE AND NOT SILVERDAW_BUILD_TESTS)
    message(FATAL_ERROR "SILVERDAW_ENABLE_COVERAGE requires SILVERDAW_BUILD_TESTS=ON")
endif()

add_library(silverdaw_backend_core STATIC
    # bridge
    src/bridge/BridgeAuth.cpp
    src/bridge/BridgeDispatch.cpp
    src/bridge/BridgeServer.cpp
    src/bridge/CommandHelpers.cpp
    src/bridge/PlayheadEmitter.cpp
    # commands
    src/commands/AudioDeviceCommands.cpp
    src/commands/ClipCommands.cpp
    src/commands/LibraryCommands.cpp
    src/commands/MarkerCommands.cpp
    src/commands/MixdownCommands.cpp
    src/commands/PreviewCommands.cpp
    src/commands/ProjectCommands.cpp
    src/commands/ProjectFxCommands.cpp
    src/commands/ProjectSettingsCommands.cpp
    src/commands/StemSeparationCommands.cpp
    src/commands/TrackCommands.cpp
    src/commands/TransitionCommands.cpp
    src/commands/TransportCommands.cpp
    src/commands/UndoCommands.cpp
    src/commands/WaveformCommands.cpp
    # core
    src/core/Log.cpp
    # dsp
    src/dsp/BpmDetector.cpp
    src/dsp/LoudnessAnalyzer.cpp
    src/dsp/WarpProcessor.cpp
    src/dsp/Waveform.cpp
    # engine
    src/engine/AudioEngine.cpp
    src/engine/AudioEngineClipEdit.cpp
    src/engine/AudioEngineClips.cpp
    src/engine/AudioEnginePreview.cpp
    src/engine/DecodedCache.cpp
    src/engine/EnginePlaybackPath.cpp
    src/engine/OutputDeviceClassifier.cpp
    # mixdown
    src/mixdown/MixdownBroadcast.cpp
    src/mixdown/MixdownEngine.cpp
    src/mixdown/MixdownExport.cpp
    src/mixdown/MixdownGraph.cpp
    src/mixdown/MixdownNormalize.cpp
    src/mixdown/MixdownRender.cpp
    src/mixdown/MixdownRenderPass1.cpp
    src/mixdown/MixdownSnapshot.cpp
    # project
    src/project/EditUndoState.cpp
    src/project/LibraryAnalysis.cpp
    src/project/PeaksCache.cpp
    src/project/ProjectFile.cpp
    src/project/ProjectSession.cpp
    src/project/ProjectState.cpp
    src/project/ProjectStateClips.cpp
    src/project/ProjectStateLibrary.cpp
    src/project/ProjectStateLibraryAnalysis.cpp
    src/project/ProjectStateMarkers.cpp
    src/project/ProjectStateProjectFx.cpp
    src/project/ProjectStateSerialization.cpp
    src/project/ProjectStateSettings.cpp
    src/project/ProjectStateTracks.cpp
    src/project/ProjectTransitions.cpp
    src/project/SampleExport.cpp
    src/project/ValueTreeJson.cpp
    # stems (bridge/job plumbing — ONNX-free, always built)
    src/stems/StemBroadcast.cpp
    src/stems/StemSeparationEngine.cpp
    src/stems/StemSeparatorFactory.cpp)

target_compile_definitions(silverdaw_backend_core PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_USE_WINDOWS_MEDIA_FORMAT=1
    JUCE_USE_LAME_AUDIO_FORMAT=1
    JUCE_STANDALONE_APPLICATION=1)

target_include_directories(silverdaw_backend_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/src/bridge
    ${CMAKE_CURRENT_SOURCE_DIR}/src/commands
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core
    ${CMAKE_CURRENT_SOURCE_DIR}/src/dsp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/engine
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mixdown
    ${CMAKE_CURRENT_SOURCE_DIR}/src/project
    ${CMAKE_CURRENT_SOURCE_DIR}/src/stems)

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
    rubberband_local
    SampleRate::samplerate
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

if(WIN32)
    # OutputDeviceClassifier walks the Windows device tree (MMDevice COM + Config Manager) to
    # detect sleep-prone USB output endpoints.
    target_link_libraries(silverdaw_backend_core PUBLIC Cfgmgr32 Ole32 Propsys)
endif()

if(SILVERDAW_ENABLE_STEM_SEPARATION)
    target_link_libraries(silverdaw_backend_core PUBLIC onnxruntime)
    target_compile_definitions(silverdaw_backend_core PUBLIC SILVERDAW_STEM_SEPARATION=1)
    if(SILVERDAW_ONNXRUNTIME_DIRECTML)
        target_compile_definitions(silverdaw_backend_core PUBLIC SILVERDAW_ONNXRUNTIME_DIRECTML=1)
    endif()
    # The real ONNX inference is only compiled when stem separation is enabled;
    # the factory falls back to a stub otherwise.
    target_sources(silverdaw_backend_core PRIVATE src/stems/OnnxStemSeparator.cpp)
endif()

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
    src/core/Main.cpp)

target_link_libraries(SilverdawBackend PRIVATE
    silverdaw_backend_core)

# ─── ONNX Runtime DLL (bundled, MIT) ─────────────────────────────────────
# ONNX Runtime is a shared library. Copy onnxruntime.dll next to the backend
# executable so it resolves at runtime, and so the electron-builder
# extraResources step ships it inside the installer next to SilverdawBackend.exe.
if(SILVERDAW_ENABLE_STEM_SEPARATION)
    add_custom_command(TARGET SilverdawBackend POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${SILVERDAW_ONNXRUNTIME_DLL}"
            "$<TARGET_FILE_DIR:SilverdawBackend>/onnxruntime.dll"
        COMMENT "Copying onnxruntime.dll next to backend executable")
    # The DirectML build's EP depends on DirectML.dll at runtime; ship it too.
    if(SILVERDAW_ONNXRUNTIME_DIRECTML AND SILVERDAW_DIRECTML_DLL)
        add_custom_command(TARGET SilverdawBackend POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${SILVERDAW_DIRECTML_DLL}"
                "$<TARGET_FILE_DIR:SilverdawBackend>/DirectML.dll"
            COMMENT "Copying DirectML.dll next to backend executable")
    endif()
endif()

# ─── LAME MP3 encoder (optional, bundled) ────────────────────────────────
# JUCE's LAMEEncoderAudioFormat spawns a `lame.exe` child process to
# encode MP3. Drop a Windows lame.exe build into
# `backend/third_party/lame/lame.exe` and it will be copied next to
# the backend executable at build time. See third_party/lame/README.md
# for download links. If the file is absent the build still succeeds —
# MP3 export will simply fail at runtime with a friendly message.
set(SILVERDAW_LAME_EXE "${CMAKE_CURRENT_SOURCE_DIR}/third_party/lame/lame.exe"
    CACHE FILEPATH "Path to bundled lame.exe (Windows MP3 encoder)")
if(EXISTS "${SILVERDAW_LAME_EXE}")
    message(STATUS "MP3 export: lame.exe found at ${SILVERDAW_LAME_EXE}")
    add_custom_command(TARGET SilverdawBackend POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${SILVERDAW_LAME_EXE}" "$<TARGET_FILE_DIR:SilverdawBackend>/lame.exe"
        COMMENT "Copying lame.exe next to backend executable")
else()
    message(STATUS
        "MP3 export: lame.exe NOT found at ${SILVERDAW_LAME_EXE} — "
        "MP3 export will be unavailable at runtime. "
        "See backend/third_party/lame/README.md.")
endif()

if(SILVERDAW_BUILD_TESTS)
    enable_testing()

    add_executable(SilverdawBackendTests
        tests/BackendTests.cpp
        tests/ProjectStateTests.cpp
        tests/ProjectStateFxTests.cpp
        tests/PersistenceTests.cpp
        tests/BridgeTests.cpp
        tests/WarpTests.cpp
        tests/AudioEngineTests.cpp
        tests/FxDspTests.cpp
        tests/LoudnessTests.cpp
        tests/EnvelopeFadeTests.cpp
tests/MixdownRenderTests.cpp
        tests/StemSeparationTests.cpp
        tests/BpmDetectorTests.cpp)
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
