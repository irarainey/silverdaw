<#
.SYNOPSIS
    End-to-end Release build of Silverdaw — backend (CMake / MSVC), frontend
    (electron-vite), and a packaged Windows installer (electron-builder /
    NSIS).

.DESCRIPTION
    Runs the three release phases in order, aborting on the first failure:

      1. Configure + build the JUCE backend in Release.
         Output: backend/build-release/SilverdawBackend_artefacts/Release/SilverdawBackend.exe

      2. Compile the Electron main / preload / renderer bundles.
         Output: frontend/out/{main,preload,renderer}

      3. Package an NSIS installer that bundles the Electron runtime, the
         compiled JS bundles, the backend exe, the icons, the LICENSE and
         the third-party notices.
         Output: dist/Silverdaw-Setup-<version>.exe

    Run from the repository root (or any directory — paths resolve relative
    to this script).

.PARAMETER SkipBackend
    Skip the backend configure + build step (useful when only the frontend
    or installer config has changed).

.PARAMETER SkipFrontendInstall
    Skip the `pnpm install` step in `frontend/`.

.EXAMPLE
    pwsh -NoProfile -File scripts/Build-Release.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipBackend,
    [switch]$SkipFrontendInstall
)

$ErrorActionPreference = 'Stop'

$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir= Join-Path $repoRoot 'frontend'
$devShell   = Join-Path $PSScriptRoot 'Invoke-DevShell.ps1'

function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host ("  $Title") -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor Cyan
}

# 1. Backend ---------------------------------------------------------------
if (-not $SkipBackend) {
    # Release builds get their own CMake build directory so we never
    # clobber the Debug cache that VS Code's `backend: build` task
    # relies on. Ninja is a single-config generator — sharing a build
    # dir with Debug means whichever configure ran last wins, and the
    # other config silently gets the wrong artefact.
    $backendBuildDir = Join-Path $backendDir 'build-release'

    Write-Section 'Backend: configure (Release)'
    & $devShell "cmake -S `"$backendDir`" -B `"$backendBuildDir`" -G Ninja -DCMAKE_BUILD_TYPE=Release"
    if ($LASTEXITCODE -ne 0) { throw "Backend configure failed (exit $LASTEXITCODE)" }

    Write-Section 'Backend: build (Release)'
    & $devShell "cmake --build `"$backendBuildDir`" --parallel"
    if ($LASTEXITCODE -ne 0) { throw "Backend build failed (exit $LASTEXITCODE)" }

    $backendExe = Join-Path $backendBuildDir 'SilverdawBackend_artefacts\Release\SilverdawBackend.exe'
    if (-not (Test-Path $backendExe)) {
        throw "Backend exe not found at $backendExe after a successful build"
    }
    Write-Host "Backend exe: $backendExe"
} else {
    Write-Host 'Skipping backend build (--SkipBackend).' -ForegroundColor Yellow
}

# 2. Frontend deps + bundles ----------------------------------------------
Push-Location $frontendDir
try {
    if (-not $SkipFrontendInstall) {
        Write-Section 'Frontend: pnpm install'
        pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
    }

    # 3. Bundles + installer (electron-vite + electron-builder) ----------
    # Kill any running instances of the packaged Silverdaw + backend so
    # electron-builder can wipe the previous `dist/win-unpacked/` tree.
    # Electron's multi-process model means a single closed UI window can
    # leave half a dozen helper processes hanging on to file handles
    # inside that directory; trying to overwrite produces "cannot delete"
    # mid-build. Cheap to do unconditionally.
    Write-Section 'Frontend: stop any running packaged Silverdaw'
    $stale = Get-Process Silverdaw, SilverdawBackend -ErrorAction SilentlyContinue
    if ($stale) {
        $stale | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-Host ("Stopped {0} process(es)" -f $stale.Count)
    } else {
        Write-Host 'No running Silverdaw processes.'
    }

    Write-Section 'Frontend: build bundles + NSIS installer'
    # Wipe the previous `dist/` outputs so each release is a clean build —
    # avoids stale `win-unpacked/` files lingering when source files are
    # renamed/removed between builds, and guarantees the installer we
    # ship matches exactly the contents of `out/`. We preserve the
    # `.gitkeep` marker so the directory stays tracked in git.
    $distDir = Join-Path $repoRoot 'dist'
    if (Test-Path $distDir) {
        Get-ChildItem -LiteralPath $distDir -Force -Exclude '.gitkeep' |
            Remove-Item -Recurse -Force -ErrorAction Stop
        Write-Host "Cleared $distDir (preserved .gitkeep)"
    }

    pnpm dist
    if ($LASTEXITCODE -ne 0) { throw "pnpm dist failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

# Report what we produced -------------------------------------------------
Write-Section 'Done'
$installer = Get-ChildItem -Path (Join-Path $repoRoot 'dist') -Filter 'Silverdaw-Setup-*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($installer) {
    Write-Host ("Installer: {0} ({1:N1} MB)" -f $installer.FullName, ($installer.Length / 1MB)) -ForegroundColor Green
} else {
    Write-Warning "No installer found under $repoRoot/dist."
}
