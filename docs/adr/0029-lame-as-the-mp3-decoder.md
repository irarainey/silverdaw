# ADR 0029 — MP3 is decoded by the bundled LAME binary, with the JUCE reader kept only as a fallback, and `lame.exe` becomes a required build dependency

- **Date:** 2026-08-31 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Context

A library MP3 that plays correctly in other software could not be played,
auditioned, or analysed in Silverdaw. It reported no tempo, drew no waveform,
and made no sound. The only trace was a single `warn` line in the backend log.

The cause is in JUCE's MP3 reader, not in Silverdaw. For a 192 kbps file it
reported 9,965,952 samples (225.99 s) against a true length of 301.34 s. The
ratio is exactly **0.75**, which is 192/256: the reader sized the stream as
though it were 256 kbps, so every frame boundary after the first was wrong.
`read()` then returned `false` on 608 of 609 blocks **while still writing
samples of magnitude 20.05** — valid float audio is within about ±1.0. Both
`read()` overloads behaved identically, and skipping the 104,158-byte ID3v2.3
tag changed nothing.

Two structural facts turned that into a total failure rather than a degraded
one:

- **One decode feeds everything.** `DecodedCache::ensureDecoded` breaks out of
  `writeDecodedBlocks` on the first failed read, so `samplesWritten` was 0, the
  staging file was deleted, and `{}` was returned. Playback, waveform peaks, and
  tempo detection all consume that decoded WAV, so all three died together from
  one root cause.
- **Preview did not use the cache at all.** `PreviewCommands` opened the
  original MP3 directly on a cache miss, through the same broken reader. Fixing
  the cache alone would have left the file-browser audition silent, which is
  where the problem was first noticed.

### What measurement showed

The choice was made on measurement rather than on the single motivating file,
using the real `writeDecodedBlocks` path in a Release build so that the
comparison was like-for-like.

Over 25 library MP3s:

| | Complete decodes | Fully failed | Silently truncated |
| --- | --- | --- | --- |
| JUCE | 6/25 | 1 | 18 |
| `lame.exe` | **25/25** | 0 | 0 |

The 18 truncations are the more troubling number. Each fell inside the 98%
`kMinDecodedFraction` tolerance, so they were accepted as a "short tail" and
never surfaced. The reader was quietly discarding audio on the majority of
files, and nothing reported it.

Speed is not a differentiator: **7,921 ms (JUCE) versus 7,958 ms (LAME)** across
the 24 files both could attempt, about 330 ms each. The LAME figure includes
process-spawn overhead, so it is pessimistic. A further 40 randomly sampled
library files decoded 40/40 through LAME at 307 ms average. Non-ASCII paths were
tested explicitly, because MP3 *export* sidesteps them via temp files and
decoding cannot: a file with Latin and Japanese characters in its name decoded
correctly.

## Decision

**`lame.exe` is the decoder for MP3. The JUCE reader is retained only as a
fallback.** LAME was already shipped for MP3 export, so this adds coverage
without adding a dependency.

Six parts:

1. **Route MP3 through LAME in `DecodedCache`,** falling back to
   `decodeWithJuceReader` if the binary is missing or the decode fails. The
   fallback means the change can only add coverage relative to the old
   behaviour. The decoder that produced each file is recorded in its
   `decodedcache` log line, so a decode can be attributed after the fact.
2. **Bump `kDecodedCacheGeneration` from 2 to 3,** re-decoding every MP3 on
   first use and recalculating its beat markers against the corrected audio.
3. **Decode preview through the cache.** `PREVIEW_LOAD` decodes an uncached MP3
   on a worker thread before auditioning it. Only the newest audition may load,
   tracked by its own request counter rather than the engine's preview
   generation, which advances only after a successful load.
4. **Make `lame.exe` required at configure time.** MP3 import and MP3 export
   both depend on it.
5. **Share one locator.** `findLameExecutable()` moves to `core/LamePath` so the
   encoder and decoder can never disagree about where the binary lives.
6. **Probe MP3 through the same cache.** `AUDIO_FILE_PROBE` read the file's
   header with the JUCE reader, so it reported 225.99 s for the motivating file
   and refused others outright — on the import path, before any decode was
   attempted. It now probes the decoded WAV for MP3, so the duration a user
   imports matches the audio that will play, and the decode the import needs is
   already warm.

**LAME stays a child process; it is not linked in.** This is a licence
constraint, not an implementation preference. LAME is LGPL-2.1-or-later and
Silverdaw is AGPL-3.0-or-later (ADR 0010); the argument recorded in
`THIRD_PARTY_LICENSES.md` is that the LGPL boundary is the process boundary.
Linking `libmp3lame` in-process would invalidate that analysis.

### Why the build fails without it, rather than degrading

Making the dependency optional is the more usual choice, and it was rejected
deliberately. A build without `lame.exe` would fall back to the reader this ADR
exists to stop using — so the failure mode of "optional" is not missing MP3
support, which is visible, but **silently reinstating the broken decoder on the
most common source format a user has**. The binary is not in the repository
(`.gitignore` excludes `*.exe`); `scripts/Fetch-Lame.ps1` retrieves it, and both
`Setup-Dev.ps1` and CI run it before configuring.

## Consequences

**Decoded MP3 audio now starts about 12 ms earlier.** LAME strips the MP3
encoder delay — typically 529 samples — that JUCE left in place. Measured by
cross-correlation, JUCE's output was 529 samples later on 5 of 6 files, and 1105
(529 plus one 576-sample granule) on the sixth. This is the correct gapless
behaviour and makes decoding *more* accurate, but it does move the audio.

The generation bump handles derived data automatically. It does not handle
manual work: **a beat anchor a user adjusted by hand in a project saved before
this will sit 12 ms out** and wants correcting once. ADR 0027's Edit BPM and the
Clip Editor beat grid are the tools for that. The scale is small enough to be a
one-off correction rather than a migration, and 1.8.0 is already a
beat-accuracy release.

### Limits, stated plainly

- **The precise fault inside JUCE is not pinned down.** The 0.75 ratio proves
  the reader used the wrong frame size; whether that came from a false sync, a
  malformed first frame, or a CBR assumption was not established, and nothing
  has been reported upstream.
- **There is no global bound on concurrent LAME processes.** Each decode spawns
  one, with a size-derived timeout and an exit-code and output check, but a
  large simultaneous import is not throttled.
- **Child-process launch has not been smoke-tested from a packaged MSIX build.**
  It is exercised in dev and unpacked builds.

## Rejected alternatives

- **Keep JUCE and widen the tolerance.** The motivating file failed completely,
  not marginally, so no threshold rescues it. Loosening
  `kMinDecodedFraction` would only hide the 18 truncations more thoroughly.
- **Chain three decoders (JUCE, then Media Foundation, then LAME).** Media
  Foundation was the generation-1 decoder and was dropped after it truncated a
  file. It also cannot be reached as an automatic fallback: JUCE's
  `registerBasicFormats` registers `MP3AudioFormat` first and `createReaderFor`
  returns the first format that opens the file. A third decoder adds a third
  behaviour to reason about and a third set of alignment characteristics, for no
  measured coverage.
- **Link `libmp3lame` or `libmpg123` in-process.** Faster, and it would remove
  the process-spawn overhead — but spawn overhead is already within noise at
  ~330 ms per file, and linking changes the licence analysis above.
- **Decode every format with LAME.** Only MP3 was implicated. WAV, FLAC, AIFF
  and the Windows Media formats decode correctly through JUCE, and widening the
  change would put working paths at risk for no benefit.
- **Return a structured error from `ensureDecoded` so each caller can report
  it.** Genuinely desirable, and the silent failure is what made this expensive
  to diagnose. Rejected *here* because a low-level cache is the wrong place to
  originate user-facing messaging, and doing it properly touches every caller.
  Left as its own decision.
- **Wait for a fix upstream in JUCE.** The file is unplayable now, and the
  fallback already covers the case where LAME is unavailable.

## Notes

Decoding is validated by reading the result back with `juce::WavAudioFormat`
directly rather than through `AudioFormatManager`. This is not incidental: the
manager selects a reader by file **extension**, and decodes stage to a
`.wav.tmp` path. Nothing is registered for `.tmp`, so an extension-based check
rejects every good decode — which disabled the LAME path entirely while looking
exactly like a decode failure. `DecodedCacheTests` pins this.
