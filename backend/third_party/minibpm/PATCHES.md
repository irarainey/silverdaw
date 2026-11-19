# MiniBPM — vendored copy

Upstream: <https://github.com/breakfastquay/minibpm>
(mirror of <https://hg.sr.ht/~breakfastquay/minibpm>)

## Files

| File | Origin |
| --- | --- |
| `MiniBpm.h` | upstream `src/MiniBpm.h`, **unmodified** |
| `MiniBpm.cpp` | upstream `src/MiniBpm.cpp`, **unmodified** |
| `LICENSE.txt` | upstream `COPYING` (GPL-2.0 text), unmodified |
| `UPSTREAM-README.md` | upstream `README.md`, unmodified |

## Patches

**None.** Unlike BTrack, MiniBPM builds cleanly under MSVC as-is — it is
self-contained C++ with its own `M_PI` fallback and no external FFT.
Keep it that way: if a change becomes necessary, record it here
and explain why upstream could not absorb it, so the next update is a
re-download rather than a merge.

The Java, JNI and Vamp-plugin wrappers, the test suite and the build files from
upstream are deliberately not vendored — only the two source files the backend
compiles.

## Why it is here

`BpmDetector` searches for a refined period near BTrack's initial estimate.
If the candidate is in range but scores worse against BTrack's own beats,
MiniBPM analyses the unconditioned mono audio as an independent check. A
decisive estimate can tip the choice toward the candidate; MiniBPM does not
supply a replacement seed or run on every analysis.

It reports **tempo only** — no beat positions and no phase — so it cannot
replace the existing ODF period/phase refinement, which is what actually places
the beat markers.

## Licence

GPL-2.0-**or-later**, which is what makes it usable here: the code is taken
under GPL-3.0, and AGPL-3.0 §13 expressly permits combining an AGPL work with
GPL-3.0 code. A GPL-2.0-only dependency would have been incompatible with the
project licence. See the repository-root `THIRD_PARTY_LICENSES.md`.

A commercial licence is also offered by the copyright holders; Silverdaw relies
on the GPL grant only.
