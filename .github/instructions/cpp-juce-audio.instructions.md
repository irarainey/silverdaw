---
description: "C++17, JUCE, and real-time audio processing standards for Silverdaw"
applyTo: "**/*.{cpp,h,hpp,cxx,cc}"
---

## C++ / JUCE Audio Development Instructions

Use these rules when modifying Silverdaw's C++ backend, especially code under
`backend/src`. The backend is a JUCE 8 headless audio engine, so correctness,
real-time safety, and predictable performance are more important than clever
or compact code.

## Core Principles

- Preserve real-time audio safety. The audio callback must not block,
  allocate, log, throw, wait on locks, perform filesystem I/O, or call APIs
  that can unexpectedly allocate or take locks.
- Prefer clear ownership and explicit lifetimes over hidden global state.
- Keep code deterministic. Avoid background side effects unless they are part
  of an existing thread, timer, or worker-pool pattern.
- Respect the existing architecture: JUCE audio sources, the bridge server,
  `ProjectState`, `AudioEngine`, cache helpers, and worker jobs each have
  distinct responsibilities.
- Make changes complete across model, engine, bridge, persistence, and tests
  when behavior crosses those boundaries.

## Language and Style

- Target C++17 unless the project configuration changes.
- Prefer RAII, value types, `std::unique_ptr`, `std::optional`, and scoped
  objects over manual lifetime management.
- Use `std::atomic` only for narrow cross-thread state that can be reasoned
  about. Document memory-order expectations when they are not obvious.
- Avoid raw owning pointers. Raw pointers are acceptable for non-owning JUCE
  graph references when ownership is clearly held elsewhere.
- Keep functions focused and named for domain behavior, not implementation
  details.
- Avoid broad `catch (...)` blocks and silent failure. Return `juce::Result`,
  `bool` with logged context, or a clear error string following nearby
  project patterns.
- Do not introduce `using namespace` in headers.
- Keep headers lightweight. Put implementation details in `.cpp` files unless
  inline code is needed for templates or trivial accessors.

## JUCE Audio Graph Rules

- Treat `prepareToPlay`, `getNextAudioBlock`, and `releaseResources` as the
  authoritative audio lifecycle.
- Allocate buffers, scratch storage, and expensive objects in constructors,
  setup methods, or `prepareToPlay`, not in `getNextAudioBlock`.
- Keep `getNextAudioBlock` bounded and branch-light. It should consume already
  prepared state and write predictable output.
- Always clear inactive buffer regions explicitly when a source is silent,
  outside its clip window, unresolved, muted, or stopped.
- When changing graph topology while playback may be active, account for
  JUCE read-ahead buffers and stale prefetched audio.
- Preserve sample-rate correctness. Convert between milliseconds, samples,
  and timeline positions using the active sample rate and existing helpers.
- On sample-rate changes, rescale stored sample positions when continuity
  matters.

## Real-Time Thread Safety

- Never perform these operations on the audio thread:
  - heap allocation or container growth;
  - file reads/writes, cache access, or JSON work;
  - bridge sends, logging, or UI notifications;
  - locks, condition variables, sleeps, process spawning, or thread joins;
  - blocking JUCE message-thread calls.
- If message-thread state must affect audio, publish small immutable values
  through atomics or an existing lock-free handoff pattern.
- When swapping processors or audio sources, use a publish-then-replace
  discipline consistent with the existing engine code.
- Rebuild expensive processors only when required. Prefer atomic parameter
  updates for live changes.

## Time, Tempo, Warp, and Position Mapping

- Be explicit about the time domain of every value:
  - project timeline time;
  - source-file time;
  - device samples;
  - source samples;
  - warped/effective timeline duration.
- Do not mix source-time `durationMs` with timeline/effective duration.
  Warped clips use source-time trim fields but project onto the timeline as
  `sourceDuration / tempoRatio`.
- Keep ratio direction consistent:
  - Silverdaw `tempoRatio = projectBpm / sourceBpm`;
  - Rubber Band `setTimeRatio()` receives output/input, so it uses the
    inverse internally.
- For seeks in warped playback, map timeline offset back to source offset
  through the effective tempo ratio before reading source audio.
- Keep waveform drawing, hit testing, collision detection, crop/split logic,
  and backend audio windowing aligned to the same duration model.

## Performance Guidelines

- Prefer precomputed scratch buffers over per-block temporary containers.
- Avoid repeated path, JSON, string, and `ValueTree` traversals in hot paths.
- Keep bridge payloads compact and avoid sending large binary data over the
  control WebSocket.
- Use caches deliberately for decoded audio, waveform peaks, and analysis
  data. Invalidate only the affected entries.
- Do not add polling loops when an event, callback, or existing timer can
  drive the work.
- Use release-mode behavior when evaluating performance-sensitive changes.

## `ProjectState` and Persistence

- Treat `ProjectState` as the backend's durable project model. If a new
  property affects saved projects, wire it through:
  - mutation helpers;
  - JSON save/load;
  - bridge project-state output;
  - engine rebuild from project state;
  - tests.
- Keep undo/dirty semantics consistent with nearby setters.
- Preserve forward compatibility: unknown saved fields should not break load.
- Do not store transient audio-thread state in the project file.

## Bridge and Error Handling

- Validate bridge inputs before mutating state or touching the audio engine.
- Keep backend and frontend protocol semantics synchronized. Add shared tests
  when a new envelope or payload field is introduced.
- Prefer explicit bridge acknowledgements or state broadcasts for backend-
  originated changes so the renderer does not drift from engine state.
- Log useful context on failures, but never log from the audio callback.

## Testing and Validation

- Add or update backend tests for model persistence, bridge-relevant state,
  timing math, warp ratio mapping, cache behavior, and bug fixes.
- For audio changes, test the pure math or state transitions directly where
  possible. Use smoke tests for third-party DSP integration when full audio
  assertions would be brittle.
- Run existing backend build/tests after C++ changes:
  - configure/build via the repository scripts or CMake;
  - `ctest --test-dir backend/build --build-config Debug --output-on-failure`.
- When packaging-related C++ changes affect Windows runtime dependencies,
  inspect the release executable dependencies with `dumpbin /dependents`.

## Comments and Documentation

- Comment real-time constraints, thread ownership, ratio direction, and
  non-obvious JUCE lifecycle behavior.
- Avoid comments that restate the code.
- Update project documentation or instruction files only when the change
  affects developer workflow, architecture, or packaging behavior.

## File Size and Single Responsibility

- A translation unit / header should be one coherent unit of thought. If you
  can't describe it in one short sentence, split it.
- Soft ceilings (scrutinise above): `.cpp` ~500 lines, `.h` ~250
  (declarations only). **Any file > 800 lines must be seriously considered for
  splitting unless there is a very good, explicitly-stated reason.** Line count
  is a symptom, not the goal.
- Legitimate reasons to stay large: a genuinely cohesive real-time DSP chain
  (e.g. one `processBlock` path) — never fragment a real-time audio path purely
  to chase a line count, that is worse than keeping it together.
- Prefer extracting cohesive free-function command groups into their own TU
  (mirror `TransitionCommands.cpp`) over growing `Main.cpp` / `ProjectState.cpp`.
  Move via pure mechanical extraction (no behaviour change), keeping the build
  and `ctest` green at each step. Watch for ODR, static-init-order, and
  threading hazards when moving file-local statics across TUs.
