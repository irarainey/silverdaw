# ADR 0028 — Tempo detection conditions the audio, settles disputes with an independent second engine, and fits the grid to onset starts

- **Date:** 2026-08-29 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Context

ADR 0027 gave the user a way to correct a mis-detected tempo. That is the right
safety net, but it is a manual one: every correction is a moment where the app
got it wrong and the user had to know better. This ADR is about making that
moment rarer.

The motivating file is the one that prompted ADR 0027. It is really 102.76 BPM
and was detected as **98.80** — around 4% out, in exactly the band ADR 0027
identifies as damaging, where the material drifts audibly but no ÷2 / ×2 button
helps.

### The failure was circular validation, not a bad seed

Reading the detector log for that file was decisive, and it contradicted the
obvious hypothesis. `BpmDetector` runs BTrack to get a tempo seed and beat
times, then refines the period by autocorrelation within ±10% of that seed:

| Stage | Value |
| --- | --- |
| BTrack running estimate | 102.336 — nearly right |
| Least-squares fit over BTrack's beats | 98.813 |
| Autocorrelation candidate | **103.992 — very close to truth** |
| Accepted result | 98.804 |

The right answer was found and thrown away. The ±10% refinement window already
contained the truth, so a better *seed* would not have fixed this, and neither
would a wholesale detector replacement have been necessary to fix it.

The reason it was discarded is the acceptance gate. It scores each candidate
period against **BTrack's own detected beat times**, requiring an equal-or-better
residual. When those beat times are themselves unreliable — this file was flagged
`variableTempo` and `lowConfidence`, keeping only 40 of 67 beats — the period
that generated them wins on its own evidence. The test is circular in precisely
the case where it is most needed, because it has no information that is
independent of the thing under suspicion.

### What measurement showed

Guessing was replaced with the existing `bpm_eval` harness over five real tracks
with Rekordbox ground truth, corroborated against Beatport and Beatsource. Two
things fell out that changed the plan:

- On real music the error is **precision, not octave**: same octave 5/5, zero
  wild disagreements. The original hypothesis — that a second engine was needed
  to catch half/double-time errors — was wrong for this corpus.
- The synthetic corpus cannot discriminate accuracy at all (both engines within
  0.007 BPM). It validates plumbing only. Worse, both engines folded a 174 BPM
  file to 87 — they **agreed while both being wrong**, which is direct evidence
  that agreement between correlated engines is not proof of correctness.

## Decision

Two independent changes, each measured separately.

### 1. Condition the audio ahead of beat tracking

`emphasisePercussiveContent` emphasises the kick band (below ~180 Hz) and the
snare/hat band (above ~4 kHz) and attenuates the middle, where sustained guitar,
pad and vocal energy contributes to the onset detection function while carrying
the beat far less clearly. BTrack and the ODF refinement both run on this
conditioned buffer.

The mid is **attenuated to 0.10, not removed**. Removing it entirely measured
best on the corpus, but the corpus is five rock, soul and dance tracks. Hand
percussion, piano, muted guitar, filtered or lo-fi drums and acoustic material
can carry their clearest pulse between these bands, and for those a full cut
would leave no beat evidence at all — with both the baseline and the
autocorrelation candidate failing together, so nothing downstream would notice.
A weight of 0.25 was tried and erased the accuracy gain outright (mean error
back to 0.761 BPM); 0.10 keeps the gain while leaving mid-led material something
to track. This is explicitly insurance against material not in the corpus.

**The filter must be zero phase, and that is a correctness constraint rather
than a quality preference.** `BpmDetector` de-biases its beat anchor by a
calibrated ODF group delay (`kOdfGroupDelayFrames`), and that anchor places the
beat markers the user sees. A biquad or any other IIR filter has
frequency-dependent delay, so it would shift onsets by an amount that varies
with the material — silently invalidating the calibration and moving every
marker, with no failure that any test would report as an error. Only symmetric
FIR kernels applied centred are used.

Two details matter for that guarantee to actually hold:

- The kernels are applied over a **reflected extension** of the signal. Simply
  shrinking the averaging window at the file boundaries — the obvious
  implementation — makes the operator time-varying there, so its impulse
  response stops being symmetric and onsets in the first and last few
  milliseconds acquire a small timing bias. That is precisely where a clip's
  opening beat tends to sit. `testPercussiveEmphasisPreservesOnsetTiming`
  asserts sample-wise symmetry at the start, middle and end of a buffer.
- **Zero phase guarantees the filter adds no delay; it does not guarantee that
  the detector's chosen onset times are unchanged.** Re-weighting bands can
  still change which transient wins a contested ODF peak — a kick and a snare a
  few milliseconds apart can swap. The claim that markers do not move is
  therefore supported by measurement, not by the filter property alone.

### 2. Break a disputed refinement with an independent arbiter

MiniBPM is vendored as a second estimator. It is **not** consulted routinely.
It runs only when the residual gate would reject the autocorrelation candidate —
the circular case above — and it may overturn that rejection only when it is
within 2.0 BPM of the autocorrelation period and at least 0.25 BPM closer to it
than to the baseline. A winner that barely beat its own runner-up is treated as
an ambiguous readout rather than a second opinion, and arbitrates nothing.

Three properties of this shape matter:

- **It costs nothing in the common case.** A file whose refinement is
  uncontested never runs the second engine, so the routine import path is
  unchanged.
- **The arbiter is fed the raw decode, not the conditioned buffer.** Sharing a
  front-end would make the two engines inherit the same blind spots and
  manufacture agreement, destroying the independence the tie-break depends on.
- **It arbitrates between two existing candidates rather than supplying a third
  answer.** MiniBPM reports tempo only, with no beat positions or phase, so it
  cannot place markers. Taking its number directly would break the pairing of
  period and phase that the ODF stages maintain.

An additional gate was tried and **rejected on measurement**: restricting
arbitration to files whose baseline beat fit already looks weak (low retained
fraction or high residual). It is the intuitive rule — only overturn evidence
that is visibly poor — but the corpus contains a file whose beats are entirely
self-consistent (100 of 100 retained, 20 ms residual) while its tempo is still
1.7 BPM out. Gating on fit quality suppressed that correction and made overall
accuracy worse. A tidy beat sequence is evidence of self-consistency, not of
correctness, so it is not used to gate arbitration.

MiniBPM's narrow 55–190 search range is folded to the baseline's octave before
comparison. `BpmDetector`'s own 40–240 range is left alone: it is a **rejection
gate** returning "no tempo", not a search range, and narrowing it would convert
usable detections into no result at all.

### 3. Fit the grid to onset starts, not to ODF peaks

Conditioning and arbitration both decide *what the tempo is*. Neither decides
*where the beat falls*, and measurement showed the grid was consistently late.

The onset detection function is a complex spectral difference over 1024-sample
frames at hop 256, so one frame is 5.8 ms at 44.1 kHz. Its peak marks the moment
of fastest spectral change, which is not the moment the note starts. Probing the
synthetic corpus put the gap at **+0.7 ms on broadband clicks but +3.0–3.6 ms on
drums and pads**: energy that arrives gradually across several frames peaks later
relative to its own onset than energy that arrives all at once.

That the error is **material-dependent is the whole point**. A single calibrated
group-delay constant — which is what the detector had — can be correct for one
kind of material or the other, never both, and no amount of retuning changes
that. The fix has to be a measurement per onset rather than a constant.

`estimateOnsetStartFrames` therefore walks back from each ODF peak to the point
where the function has fallen to 75% of that peak's height above the onset's own
foot, interpolating between frames because a 5.8 ms frame is coarser than the
~3 ms bias being corrected. `refineGridFromOdfPeaks` fits the grid to those
starts. Three details are load-bearing:

- **The foot is this onset's, not the global minimum.** The backward search stops
  at the first upward turn beyond a small noise tolerance, so on a flam the
  second hit does not backtrack past the first.
- **The result is clamped to the peak**, so a degenerate or flat ODF can only
  fail to move a marker, never move one forward.
- **The fraction self-adapts.** Backtracking a proportion of each onset's own
  height is what makes one rule fit both a click and a pad; 0.75 was the value
  that minimised both mean error and, more importantly, the spread *between*
  materials.

An earlier hypothesis, that the lateness was the notes' own finite attack time,
was **disproved**: the corpus synthesises instantaneous attacks. The cause is
spectral smearing across analysis frames, which is why the correction belongs in
the ODF stage rather than in the corpus or the tempo estimate.

## Consequences

Measured over the five real tracks, mean absolute error:

| | mean \|err\| | within 0.5 BPM |
| --- | --- | --- |
| Before (neither change) | 1.265 BPM | 1/5 |
| Arbiter only | 0.538 BPM | 2/5 |
| Both changes | **0.439 BPM** | **3/5** |

Per track, against Rekordbox:

| Track | Truth | Before | After |
| --- | --- | --- | --- |
| Can't Stop These Things | 102.76 | 98.80 (−3.96) | 104.02 (+1.26) |
| Big Fun (12") | 120.17 | 120.13 (−0.04) | 120.14 (−0.03) |
| California Soul | 94.02 | 93.43 (−0.59) | 93.84 (−0.18) |
| Funky President | 104.18 | 102.47 (−1.71) | 103.48 (−0.70) |
| Last Night A DJ (12") | 109.87 | 109.85 (−0.02) | 109.85 (−0.02) |

Most of the gain comes from the arbiter and the rest from conditioning, but they
fix different files: the arbiter rescues the motivating track and Funky
President, while conditioning is what improves California Soul. Neither alone
would have been enough.

The motivating file moves from 98.80 to 104.02 against a truth of 102.76 — from
4% out to 1.2% out. No track regressed. The synthetic corpus is unchanged in
both tempo (12/12) and phase (mean offset 0.0863 beat before and after),
supporting the claim that conditioning and arbitration do not move markers.

Onset-start fitting moves markers deliberately, and only earlier: mean absolute
phase offset falls from **2.63 ms to 0.57 ms**. Drums and pads land within
±0.2 ms of truth. Broadband clicks move from 0.35 ms late to about 1.6 ms early,
which is the trade the single fraction makes — the between-material spread
collapses, at the cost of slightly overshooting the material that was already
nearly right. Tempo is untouched by this stage: the corpus stays at 12/12 and
the real-track mean error is unchanged at 0.439 BPM.

Detection cost is broadly unchanged.

### Costs and limits, stated plainly

- **The corpus is five tracks**, chosen because they were to hand, plus twelve
  synthetic files that turned out to be too easy to discriminate accuracy at
  all. This is a promising pilot, not a validated result. The arbiter's
  thresholds (2.0 BPM, 0.25 BPM margin) are inferred from those five files.
- **The corpus mean is not per-onset proof.** The phase figure above is a mean
  over twelve synthetic files; opposing per-onset movements could in principle
  cancel within it. The zero-delay property of the filter is asserted directly
  by unit test, but "no marker ever moves on any material" is not established.
- **Genres outside the corpus are untested.** Mid-led, kickless, hatless,
  heavily filtered, lo-fi and acoustic material is exactly what the band split
  is least suited to, and none of it was measured. The 0.10 mid weight is
  insurance chosen on reasoning rather than evidence.
- **The arbiter's endorsement is not revalidated after the later ODF refit.**
  That refit may move the tempo by up to 5%, so the final answer is not
  guaranteed to be the candidate MiniBPM approved. This has not been observed on
  the corpus but is not prevented.
- **MiniBPM has no abort callback of its own.** The analysis timeout is therefore
  polled between the blocks fed to it, and an abandoned pass is reported as a
  timeout rather than as "no tempo found" — the distinction matters, because the
  latter would silently keep the baseline the rejection had doubted. The final
  `estimateTempo` call is still not interruptible, but it is a small fraction of
  the cost on any realistic input.
- **The 0.75 backtrack fraction is calibrated on twelve synthetic files.** They
  are the only material with beat-phase ground truth available; the five real
  tracks have none. The fraction is a single constant fitted to a small, easy
  corpus and should be treated as provisional. Whether it and the conditioning
  constants ought to be versioned together as one calibration profile is left
  open.
- **Detection remains a guess.** It is now wrong less often and by less, but the
  motivating file is still 1.2% out. **ADR 0027's Edit BPM remains the
  authoritative correction**, and nothing here reduces the need for it. That is
  the intended division: detection gets the user close, the user decides.

### Licence findings

Verified from primary sources rather than from memory or search summaries,
because getting this wrong is not recoverable once shipped.

| Component | Licence | Verified from | Compatible? |
| --- | --- | --- | --- |
| Silverdaw | AGPL-3.0-or-later | `LICENSE`, ADR 0010 | — |
| BTrack (already shipped) | GPL-3.0 | vendored copy | Yes |
| MiniBPM | GPL-2.0-**or-later** | breakfastquay's own licence page | Yes, via "or later" |
| aubio | GPL-3.0-**or-later** | upstream `COPYING` **and** a per-file header in `src/tempo/tempo.h` | Yes |

Two points worth keeping:

- **MiniBPM's "or later" clause is the whole basis of its inclusion.** Taken as
  GPL-2.0-only it would have been flatly incompatible with AGPL-3.0; the clause
  lets it be taken under GPL-3.0, which AGPLv3 §13 permits combining with. If a
  future version were ever relicensed GPL-2.0-only, it could not be updated.
- aubio was initially reported by search as GPLv2+; reading the actual files
  showed GPL-3.0-or-later. The per-file header was checked as well as `COPYING`,
  since projects do sometimes differ between the two.

A consequence worth stating: a GPL dependency means Silverdaw could never ship
as a plugin or through an app store. That is already outside its scope — it is a
standalone application that *hosts* plugins — but the door is now closed.

### Rejected alternatives

- **Replacing BTrack with MiniBPM.** MiniBPM was closer on 4 of 5 tracks and 5×
  faster, which is tempting. But it reports tempo with no beat positions or
  phase, so it cannot place markers; and it called a bare 90 BPM click track 120,
  so it is not uniformly better. It earns a seat as an arbiter, not as the
  detector.
- **Averaging the engines into a consensus.** Tempo is octave-ambiguous, so
  averaging 98.8 and 197.6 yields 148.2 — worse than either input. Any consensus
  must fold octaves first, at which point it is a tie-break rather than an
  average, which is what was built.
- **Running the arbiter on every file.** Rejected as cost with no benefit: when
  the residual test is decisive it is already using better evidence than a
  tempo-only estimator can offer.
- **An EQ ahead of onset detection.** Rejected for the group-delay reason above.
- **aubio as a third engine.** Deferred, not rejected. It is GPL-3.0-or-later
  and therefore compatible, but a substantially heavier MSVC integration than
  MiniBPM's two vendored files, and the measured gap is now small enough that a
  third opinion is unlikely to pay for itself.
