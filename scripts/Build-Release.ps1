<#
.SYNOPSIS
    End-to-end Release build of Silverdaw — backend (CMake / MSVC), frontend
    (electron-vite), and a packaged Windows installer (electron-builder /
    NSIS).

.DESCRIPTION
    Runs the three release phases in order, aborting on the first failure:

      1. Configure + build the JUCE backend in Release.
         Output: backend/build/SilverdawBackend_artefacts/Release/SilverdawBackend.exe

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
    Write-Section 'Backend: configure (Release)'
    & $devShell "cmake -S `"$backendDir`" -B `"$backendDir/build`" -G Ninja -DCMAKE_BUILD_TYPE=Release"
    if ($LASTEXITCODE -ne 0) { throw "Backend configure failed (exit $LASTEXITCODE)" }

    Write-Section 'Backend: build (Release)'
    & $devShell "cmake --build `"$backendDir/build`" --config Release --parallel"
    if ($LASTEXITCODE -ne 0) { throw "Backend build failed (exit $LASTEXITCODE)" }

    $backendExe = Join-Path $backendDir 'build\SilverdawBackend_artefacts\Release\SilverdawBackend.exe'
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
    Write-Section 'Frontend: build bundles + NSIS installer'
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
