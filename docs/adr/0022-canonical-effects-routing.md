# ADR 0022 — Canonical effects routing and mixdown parity

- **Date:** 2026-07-20 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Context

Silverdaw's track and project effects span live playback, automation, offline
mixdown, metering, and persistence. Their routing changes the audible result,
so effect placement cannot be treated as a local implementation detail or
allowed to drift between playback and export.

The product needs a clean, predictable path for beginners while retaining
useful shared effects and safe master-bus gain staging.

## Decision

The canonical signal path is:

```text
Track source
  -> Tone / Filter
  -> Compressor
  -> Saturation
  -> Bit Crusher
  -> Punch
  -> post-FX track level and effective mute / solo gain
  -> pre-pan Reverb and Delay sends
  -> equal-power pan
  -> dry project bus
  -> shared Reverb and Delay returns
  -> Glue Compressor
  -> master gain
  -> Safety Limiter
  -> metering and device / export output
```

`TrackChain` owns the per-track processor sequence. Punch follows Saturation
and Bit Crusher so transient lifting does not drive those nonlinear processors.
Reverb and Delay sends are deliberately pre-pan: a pan movement changes the
dry image without moving a track's contribution within the shared effect
returns.

Glue Compressor runs after the shared returns and before master gain. Its
automatic makeup gain is capped at 3 dB. Safety Limiter is enabled by default,
remains an explicit user control, and is the final fixed -1 dBFS guard; Glue
does not toggle it.

Offline mixdown uses the same track processing, shared effects, Glue
Compressor, master gain, and Safety Limiter order as live playback. Automation
changes targets within that same path rather than creating a separate render
route.

## Why

- One shared path makes playback, export, and automation predictable.
- Keeping Punch after nonlinear track effects gives an audible attack lift
  without making those effects harsher.
- Pre-pan sends retain a stable shared space while allowing pan to position the
  dry mix independently.
- Conservative Glue makeup and a final, user-visible limiter give useful
  cohesion without turning Glue into an uncontrolled loudness control.

## Rejected alternatives

- **Put Punch before Saturation and Bit Crusher.** This can overdrive nonlinear
  processing and add unwanted grit.
- **Use post-pan sends.** This makes pan change a track's position inside
  shared Reverb and Delay returns rather than only its dry image.
- **Maintain separate live and offline effect paths.** This risks exported
  audio differing from playback as effects evolve.
- **Have Glue silently enable or control Safety Limiter.** This hides a
  user-facing master-output choice and couples two independent controls.
