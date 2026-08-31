# LAME MP3 encoder and decoder (bundled binary)

Silverdaw uses the [LAME](https://lame.sourceforge.io/) command-line tool as a
child process for both directions of MP3:

- **Export** — JUCE's `LAMEEncoderAudioFormat` spawns it to encode MP3.
- **Import** — `DecodedCache` spawns it (`lame --decode`) to decode every MP3
  into the decoded-WAV cache, because JUCE's own MP3 reader mis-parses some
  files badly enough that they cannot be played or analysed at all. See
  *Decoding compressed sources* in `docs/developer-guide.md`.

`lame.exe` is **required**. A build without it could neither export nor import
MP3, so CMake fails at configure time rather than producing a crippled binary.
The binary ships inside the installer, so end users need no extra install steps.

## The binary is not committed to the repo

`lame.exe` is excluded by the `*.exe` rule in `.gitignore`, so a fresh checkout
does not have it — it is fetched into the build, not tracked in git:

```text
backend/third_party/lame/lame.exe   ← fetched, not tracked in git
```

Fetch it before building:

```powershell
pwsh scripts\Fetch-Lame.ps1
```

The script downloads the RareWares LAME bundle, verifies it, extracts
`lame.exe` into this folder, and runs `lame --version` as a sanity check.
`Setup-Dev.ps1` invokes it automatically when the binary is absent, and CI runs
it before both C++ jobs.

## Build & install flow

1. CMake configure prints `MP3 encode/decode: lame.exe found at …` and
   registers a POST_BUILD step on `SilverdawBackend` that copies `lame.exe`
   next to the built backend exe (`SilverdawBackend_artefacts/<Config>/`). If
   the binary is missing, configure stops with a fatal error pointing at this
   README.
2. `scripts/Build-Release.ps1` produces the Release backend; the same
   POST_BUILD copy fires for the Release artefacts folder.
3. `frontend/electron-builder.yml` whitelists `lame.exe` in the backend
   `extraResources` filter, so the packaged app ships it at
   `resources/backend/lame.exe`.
4. At runtime `findLameExecutable()` (`backend/src/core/LamePath.h`) resolves it
   as a sibling of `SilverdawBackend.exe` — works identically for dev builds,
   packaged `win-unpacked`, and installed apps. Both the encoder and the
   decoder go through this one locator, so they can never disagree about where
   the binary lives.

## Upstream / how to refresh the bundled binary

- **RareWares LAME bundle** (the standard Windows distribution):
  <https://www.rarewares.org/mp3-lame-bundle.php>
- **Source** (build yourself if you prefer):
  <https://lame.sourceforge.io/>
- Verify with `lame --version` after refreshing this copy.

## Licensing

LAME is distributed under the **LGPL-2.1-or-later**. Shipping the
unmodified executable alongside Silverdaw is permitted; we invoke it as
a separate child process (no static or dynamic linking), which keeps the
LGPL boundary cleanly outside Silverdaw's own binary. The attribution
notice lives in [`THIRD_PARTY_LICENSES.md`](../../../THIRD_PARTY_LICENSES.md)
and ships inside the installer.
