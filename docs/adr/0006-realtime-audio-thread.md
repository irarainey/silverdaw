# ADR 0006 — Real-time audio thread: lock-free, no allocation

- **Date:** 2026-05-14 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

The audio callback is a hard real-time context: **no allocation, locking,
throwing, or blocking I/O**. State the audio thread reads is reached lock-free —
`std::atomic` for scalars (master clock, offsets) and, for structured data like
per-clip envelope/breakpoint lists, an `atomic<const T*>` pointer swapped at edit
time on the message thread with a retire queue for the old buffer. Never hand
data to the audio thread via `shared_ptr` swaps.

## Why

- Any allocation, lock, or syscall in the callback risks priority inversion and
  audible dropouts (xruns). This is the non-negotiable constraint of a DAW.
- Double-buffer + single atomic pointer swap gives wait-free reads with no
  torn state and no hot-path allocation.

## Rejected alternatives

- **Mutex around shared state.** Priority inversion; unacceptable in the callback.
- **`shared_ptr` atomic swaps.** The control-block refcount and potential
  deallocation can run on the audio thread — not real-time safe.
