# Jackdaw

A digital audio workstation, built in C++ with [JUCE](https://juce.com/).

> Status: very early scaffolding. Today it opens an audio file, draws its
> waveform, and plays it back through the system output.

## Prerequisites

- **Visual Studio 2022 or 2026** (Community / Pro / Enterprise — any edition is fine)
  with the **Desktop development with C++** workload installed. That pulls in
  MSVC, the Windows SDK, and CMake.
- **Git** on `PATH` (CMake will use it to fetch JUCE the first time you configure).
- Internet access on the first build — JUCE is pulled in via CMake's
  `FetchContent`. No manual download needed.

## Opening the project in Visual Studio

Visual Studio opens CMake projects natively — there is no `.sln` to maintain.

1. Launch Visual Studio.
2. **File → Open → Folder…** and pick the `jackdaw/` folder.
3. Wait for the **CMake** output pane to finish configuring. The first
   configure will clone JUCE into `build/_deps/juce-src` — this takes a
   minute or two and only happens once.
4. In the toolbar's startup-item dropdown pick **Jackdaw.exe**, then hit
   **F5** to build and debug.

## Building from the command line (optional)

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config RelWithDebInfo
.\build\bin\RelWithDebInfo\Jackdaw.exe
```

## Project layout

```
jackdaw/
├── CMakeLists.txt        # top-level build: pulls JUCE, defines the app target
├── Source/
│   ├── Main.cpp          # JUCEApplication + main window
│   ├── MainComponent.h   # root component (transport, waveform)
│   └── MainComponent.cpp
└── .gitignore
```

## What works today

- Open `.wav` / `.aif` / `.aiff` / `.flac` / `.ogg` / `.mp3` files.
- Play / pause / stop the loaded file via the system audio device.
- Display a waveform thumbnail with a moving playhead.

## Roadmap (rough)

- Multi-track timeline & mixer
- VST3 / CLAP plugin hosting
- Time-stretching (RubberBand) and pitch-shifting
- Out-of-process **Demucs** integration for stem separation
- Project save/load
- MIDI capture and editing
