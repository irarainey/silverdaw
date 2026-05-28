# LAME MP3 encoder (bundled binary)

Silverdaw's MP3 export uses JUCE's `LAMEEncoderAudioFormat`, which spawns
the [LAME](https://lame.sourceforge.io/) command-line encoder as a child
process. The Windows `lame.exe` binary is **committed to this folder**
and ships inside the installer so end users get working MP3 export with
no extra install steps.

```
backend/third_party/lame/lame.exe   ← tracked in git
```

## Build & install flow

1. CMake configure prints `MP3 export: lame.exe found at …` and registers
   a POST_BUILD step on `SilverdawBackend` that copies `lame.exe` next to
   the built backend exe (`SilverdawBackend_artefacts/<Config>/`).
2. `scripts/Build-Release.ps1` produces the Release backend; the same
   POST_BUILD copy fires for the Release artefacts folder.
3. `frontend/electron-builder.yml` whitelists `lame.exe` in the backend
   `extraResources` filter, so the NSIS installer ships it at
   `resources/backend/lame.exe`.
4. At runtime `findLameExecutable()` resolves it as a sibling of
   `SilverdawBackend.exe` — works identically for dev builds, packaged
   `win-unpacked`, and installed apps.

If the file is ever missing (e.g., a fresh checkout before the binary is
fetched), run:

```powershell
pwsh scripts\Fetch-Lame.ps1
```

The script downloads the RareWares LAME bundle, verifies it, extracts
`lame.exe` into this folder, and runs `lame --version` as a sanity check.
`Setup-Dev.ps1` invokes it automatically when the binary is absent.
The build still succeeds without it and runtime MP3 exports return a
friendly "encoder not bundled" error; WAV and FLAC are unaffected.

## Upstream / how to refresh the bundled binary

- **RareWares LAME bundle** (the standard Windows distribution):
  <https://www.rarewares.org/mp3-lame-bundle.php>
- **Source** (build yourself if you prefer):
  <https://lame.sourceforge.io/>
- Verify with `lame --version` before committing a refreshed copy.

## Licensing

LAME is distributed under the **LGPL-2.1-or-later**. Shipping the
unmodified executable alongside Silverdaw is permitted; we invoke it as
a separate child process (no static or dynamic linking), which keeps the
LGPL boundary cleanly outside Silverdaw's own binary. The attribution
notice lives in [`THIRD_PARTY_LICENSES.md`](../../../THIRD_PARTY_LICENSES.md)
and ships inside the installer.
