# BTrack — local patches

Source: <https://github.com/adamstark/BTrack> v1.0.7 (commit at the time
of vendoring: see GitHub tag).

Two MSVC compatibility patches have been applied to `BTrack.cpp`:

1. **`#define _USE_MATH_DEFINES`** added at the top of the file so that
   `<cmath>` exposes `M_PI` under the MSVC standard library. Upstream
   relies on the GCC default of always defining the macro.

2. **Variable-length array → `std::vector` substitution** for arrays
   whose size is computed at runtime
   (`float input[onsetDFBufferSize]`, `double threshold[N]`, etc.).
   VLAs are a C99 / GCC extension and aren't valid C++ — MSVC rejects
   them. `std::vector` with the same dynamic length is the minimal
   functional replacement; the underlying `.data()` pointer is passed
   to the helper functions that accept a `double*` / `float*`.

All other files (`OnsetDetectionFunction.cpp`, `BTrack.h`,
`OnsetDetectionFunction.h`, `CircularBuffer.h`, `kiss_fft130/*`,
`LICENSE.txt`) are vendored verbatim.

The BTrack source headers specify GPL-3.0-or-later (`LICENSE.txt` contains
the GPL v3 text). The `kiss_fft130` sources retain their BSD-3-Clause notice.

To upgrade BTrack, re-copy the upstream source files and reapply the two
patches above.
