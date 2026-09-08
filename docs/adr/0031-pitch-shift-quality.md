# ADR 0031 — Pitch shifting configures Rubber Band from the shift, not only from the warp mode

- **Date:** 2026-09-07 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

`WarpProcessor::realtimeOptionsFor` now derives two Rubber Band options from
whether the clip is actually pitch shifting, instead of taking every option from
the clip's warp mode:

- **Transients.** When a clip carries a pitch shift, an R2 engine left on the
  default `OptionTransientsCrisp` is moved to `OptionTransientsMixed`. A mode
  that states its own transient handling — `tonal` is `OptionTransientsSmooth` —
  keeps it, and the R3 engine used by `complex` is untouched.
- **Pitch method.** A shift supplied at construction is a fixed shift, so R2 now
  uses `OptionPitchHighQuality` rather than `OptionPitchHighConsistency`. The
  existing escalation in `applyPendingParams` still switches to
  `OptionPitchHighConsistency` the first time the pitch changes live, which is
  the case that option exists for. R3 keeps `OptionPitchHighConsistency` at
  construction because it refuses `setPitchOption` afterwards.

A clip that only stretches time is unaffected, and so is every clip whose pitch
is unchanged. The warp mode still chooses the engine, the window and the
character of the time stretch.

The Mode picker is no longer disabled when a clip is pitch shifting without a
tempo warp. It governs the stretcher whenever the stretcher runs, so gating it
on **Enable Warp** hid the control that determined the sound.

This changes how an existing saved project renders a clip that already carries a
pitch shift. That is accepted: the change is confined to those clips and is an
improvement in every case measured, not a change of character.

## Why

`parseWarpMode` mapped `rhythmic` — the default for every clip, in six backend
files and the clip-editor draft — to `OptionEngineFaster | OptionTransientsCrisp`.
Both constants are `0x00000000`, so the default was the bare R2 configuration
with crisp transient handling.

Crisp resets component phases at every detected onset. Rubber Band's own
documentation warns this "may cause interruptions in stable sounds present at
the same time as transient events". While resampling for a pitch shift it fires
on sustained tones as well, which destroys phase coherence.

Measured on a 440 Hz sine at ±5 semitones, tempo ratio 1.0, comparing the
strongest fitted tone against everything else in the output:

| Configuration | +5 st | −5 st |
| --- | --- | --- |
| `Crisp` + `HighConsistency` (previous behaviour) | −4.3 dB, 11.5 cents sharp, amplitude 0.254 | 2.0 dB, 25.5 cents sharp, amplitude 0.352 |
| `Mixed` + `HighQuality` (this decision) | 42.3 dB, on pitch, amplitude 0.496 | 33.8 dB, on pitch, amplitude 0.498 |

The previous behaviour left only about half the input amplitude in a coherent
tone and detuned it by up to a quarter of a semitone; the artefacts were louder
than the note. The new configuration is 46.6 dB better shifting up and 31.8 dB
better shifting down, and lands on the target pitch.

`OptionTransientsMixed` was chosen over `OptionTransientsSmooth` because a
recording can be anything — a vocal, a guitar, a synth line or a drum take — so
the configuration cannot assume tonal material. Mixed resets phases only outside
the range of musical fundamentals, which keeps percussive attacks. Measured on
decaying noise bursts at ±5 semitones:

| Configuration | Crest | Pre-echo |
| --- | --- | --- |
| `Crisp` | 26.14 / 27.14 dB | −17.60 / −18.08 dB |
| `Mixed` | 26.05 / 27.25 dB | −15.44 / −15.46 dB |
| `Smooth` | 22.94 / 29.21 dB | −13.35 / −12.11 dB |

Mixed holds crest within 0.1 dB of Crisp, while Smooth dulls an upward-shifted
attack by 3.2 dB and smears the most. Mixed buys roughly 36 dB of tonal accuracy
for about 2 dB of pre-echo.

On the pitch method, Rubber Band documents `OptionPitchHighQuality` as the
option for "fixed pitch shifts where sound quality is of most concern", and
`OptionPitchHighConsistency` as the one for "arbitrarily time-varying pitch
shifts". Silverdaw applied the time-varying option to every shift, including a
clip loaded from a saved project that will never change. It is worth 1.6 dB
tonally and 1.2 dB of crest on a downward shift, and nothing on an upward one,
because both methods resample after stretching when shifting up.

## Rejected alternatives

- **Leave the mapping alone and expose more controls.** The defect is that the
  default is wrong, not that the user lacks knobs. Adding DSP options to answer
  a quality problem contradicts ADR 0011.
- **Use `OptionTransientsSmooth` when pitch shifting.** Best on sustained tones,
  but it measurably dulls percussive attacks, and a recording or a sample can
  just as easily be drums. Mixed gives up very little tonal accuracy to stay
  safe on percussion.
- **Change `parseWarpMode` so `rhythmic` never uses Crisp.** That would degrade
  pure time-stretching, which is what `rhythmic` is for and where Crisp is the
  right choice. The problem only appears when resampling for a pitch shift, so
  the adjustment belongs where the pitch scale is known.
- **Switch the default mode to `complex` (R3).** Higher quality, but it costs
  materially more CPU on every warped clip, against ADR 0017, and would change
  the sound of far more existing projects than this change does.
- **Version the behaviour so saved projects keep the old rendering.** Preserving
  a bug-for-bug pitch path would mean carrying two DSP configurations forever
  for material that measured worse on every axis. ADR 0019 protects a user's
  project from breaking, not from sounding better.
- **Use `OptionPitchHighQuality` for the R3 engine too.** It measured well, but
  R3 cannot change a pitch option after construction, so a later live pitch drag
  could not escalate to the consistent method.

## Amendments

### Amendment 1 — The transients choice is revisited when the pitch changes live

`realtimeOptionsFor` decides the transients option from the pitch scale passed
to the constructor. The offline render always builds its stretcher from the
saved clip, so it always saw the final pitch and behaved as this ADR describes.
Playback did not: a warp is normally enabled before any pitch is dialled in, and
`AudioEngine::setClipWarp` deliberately does not rebuild the stretcher for a
pitch-only change, because a rebuild resets the stretcher's history and is
audible mid-playback. A clip in the default `rhythmic` mode therefore kept
`OptionTransientsCrisp` through a live pitch shift and reproduced exactly the
behaviour the table above measures as the previous one — while the same clip
exported correctly.

`WarpProcessor::applyPendingParams` now calls `updateTransientsForPitch`
alongside the existing pitch-method escalation, using Rubber Band's
`setTransientsOption`, which R2 accepts at any time in real-time mode. The
choice is symmetric: returning the pitch to unity restores `Crisp`, so
playback matches what the render would build at every pitch rather than only at
the one the clip was created with.

Measured as the share of output energy remaining on the intended tone, a 440 Hz
sine shifted +5 semitones in `rhythmic` mode: pitch set at construction
0.99999, pitch applied live 0.036 before this amendment and 0.99999 after.
Forcing `Mixed` while leaving the pitch method on `HighConsistency` scores
0.99999, which isolates the transients option as the whole of the difference;
`tonal` and `complex` were never affected, as neither uses `Crisp`.

`Warp live pitch change matches the render path` in `backend/tests/WarpTests.cpp`
holds the two paths together.
