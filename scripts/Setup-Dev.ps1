<#
.SYNOPSIS
    One-shot developer environment setup for Silverdaw (Windows).

.DESCRIPTION
    Brings a fresh Windows machine to a buildable Silverdaw checkout in a
    single command. Idempotent — re-running is safe and only acts on what
    is missing.

    Phases (each can be skipped via a switch):

      1. Prerequisites — verifies (and optionally installs via winget) the
         tools the rest of the build assumes are on PATH:
           - MSVC Build Tools for Visual Studio 2022 (C++ workload)
           - CMake (>= 3.22)
           - Ninja
           - Node.js (>= 20)
         pnpm is activated via `corepack` (ships with modern Node).

      2. Frontend — runs `pnpm install` in `frontend/`.

      3. Backend — configures the Debug CMake cache in `backend/build/`
         (via scripts/Invoke-DevShell.ps1 so cl.exe is on PATH). CMake
         creates the build directory itself; no manual mkdir needed.
         Pass -BuildBackend to also compile the Debug binary.

    After this script completes, F5 in VS Code (or the `dev: all` task)
    will run end-to-end.

.PARAMETER SkipPrereqs
    Skip the tool-detection / winget install phase.

.PARAMETER SkipFrontend
    Skip `pnpm install` in `frontend/`.

.PARAMETER SkipBackend
    Skip the CMake configure step.

.PARAMETER BuildBackend
    After configuring, also compile the Debug backend (equivalent to the
    VS Code `backend: build` task).

.PARAMETER Yes
    Auto-accept winget installs (passes --silent --accept-package-agreements
    --accept-source-agreements). Without this flag, missing tools are
    reported and you are prompted before each install.

.EXAMPLE
    pwsh -NoProfile -File scripts/Setup-Dev.ps1

.EXAMPLE
    pwsh -NoProfile -File scripts/Setup-Dev.ps1 -Yes -BuildBackend
#>
[CmdletBinding()]
param(
    [switch]$SkipPrereqs,
    [switch]$SkipFrontend,
    [switch]$SkipBackend,
    [switch]$BuildBackend,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

$repoRoot    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$frontendDir = Join-Path $repoRoot 'frontend'
$devShell    = Join-Path $PSScriptRoot 'Invoke-DevShell.ps1'

function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host ("  $Title") -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor Cyan
}

function Write-Step([string]$Message) {
    Write-Host "  -> $Message" -ForegroundColor Gray
}

function Write-Ok([string]$Message) {
    Write-Host "  OK  $Message" -ForegroundColor Green
}

function Write-Warn2([string]$Message) {
    Write-Host "  !!  $Message" -ForegroundColor Yellow
}

function Test-CommandOnPath([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Confirm-Action([string]$Message) {
    if ($Yes) { return $true }
    $reply = Read-Host "$Message [Y/n]"
    return ($reply -eq '' -or $reply -match '^(y|yes)$')
}

function Invoke-Winget {
    param(
        [Parameter(Mandatory)] [string]$Id,
        [string]$Override
    )

    if (-not (Test-CommandOnPath 'winget')) {
        throw "winget is not available. Install 'App Installer' from the Microsoft Store, then re-run this script."
    }

    $wingetArgs = @('install', '--id', $Id, '--source', 'winget')
    if ($Yes) {
        $wingetArgs += @('--silent', '--accept-package-agreements', '--accept-source-agreements')
    }
    if ($Override) {
        $wingetArgs += @('--override', $Override)
    }

    Write-Step "winget $($wingetArgs -join ' ')"
    & winget @wingetArgs
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
        # -1978335189 = APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE (already installed, latest)
        throw "winget install '$Id' failed with exit code $LASTEXITCODE."
    }
}

function Update-PathFromMachine {
    # winget installs update Machine PATH but not the current process; merge
    # both scopes so newly installed tools are reachable without a new shell.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user, $env:Path) | Where-Object { $_ }) -join ';'
}

function Test-MsvcInstalled {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { return $false }
    $vsPath = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    return [bool]$vsPath
}

# 1. Prerequisites ---------------------------------------------------------
if (-not $SkipPrereqs) {
    Write-Section '1. Prerequisites'

    # MSVC ----------------------------------------------------------------
    if (Test-MsvcInstalled) {
        Write-Ok "MSVC Build Tools (C++ workload) detected via vswhere."
    } else {
        Write-Warn2 "MSVC Build Tools with the C++ workload not found."
        if (Confirm-Action '    Install Microsoft.VisualStudio.2022.BuildTools (C++ workload) via winget now?') {
            Invoke-Winget -Id 'Microsoft.VisualStudio.2022.BuildTools' `
                -Override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
            if (-not (Test-MsvcInstalled)) {
                throw "MSVC still not detected after install. Open 'Visual Studio Installer' and verify the 'C++ build tools' workload is selected."
            }
            Write-Ok "MSVC Build Tools installed."
        } else {
            throw "MSVC is required. Re-run with -Yes or install manually, then re-run this script."
        }
    }

    # CMake ---------------------------------------------------------------
    if (Test-CommandOnPath 'cmake') {
        $cmakeVersion = (& cmake --version | Select-Object -First 1)
        Write-Ok "CMake found: $cmakeVersion"
    } else {
        Write-Warn2 "CMake not on PATH."
        if (Confirm-Action '    Install Kitware.CMake via winget now?') {
            Invoke-Winget -Id 'Kitware.CMake'
            Update-PathFromMachine
            if (-not (Test-CommandOnPath 'cmake')) {
                throw "CMake still not on PATH. Open a new shell and re-run, or install manually."
            }
            Write-Ok "CMake installed."
        } else {
            throw "CMake is required. Install it and re-run."
        }
    }

    # Ninja ---------------------------------------------------------------
    if (Test-CommandOnPath 'ninja') {
        Write-Ok "Ninja found: $(& ninja --version)"
    } else {
        Write-Warn2 "Ninja not on PATH."
        if (Confirm-Action '    Install Ninja-build.Ninja via winget now?') {
            Invoke-Winget -Id 'Ninja-build.Ninja'
            Update-PathFromMachine
            if (-not (Test-CommandOnPath 'ninja')) {
                throw "Ninja still not on PATH. Open a new shell and re-run, or install manually."
            }
            Write-Ok "Ninja installed."
        } else {
            throw "Ninja is required. Install it and re-run."
        }
    }

    # Node.js -------------------------------------------------------------
    if (Test-CommandOnPath 'node') {
        $nodeVersion = & node --version
        Write-Ok "Node.js found: $nodeVersion"
        $major = [int](($nodeVersion -replace '^v','') -split '\.' | Select-Object -First 1)
        if ($major -lt 20) {
            Write-Warn2 "Node $nodeVersion is older than the required v20. Consider upgrading via 'winget upgrade OpenJS.NodeJS.LTS'."
        }
    } else {
        Write-Warn2 "Node.js not on PATH."
        if (Confirm-Action '    Install OpenJS.NodeJS.LTS via winget now?') {
            Invoke-Winget -Id 'OpenJS.NodeJS.LTS'
            Update-PathFromMachine
            if (-not (Test-CommandOnPath 'node')) {
                throw "Node.js still not on PATH. Open a new shell and re-run, or install manually."
            }
            Write-Ok "Node.js installed: $(& node --version)"
        } else {
            throw "Node.js is required. Install it and re-run."
        }
    }

    # pnpm (via corepack) -------------------------------------------------
    # corepack ships with Node >= 16.13 and is the supported way to pin pnpm
    # to the version declared in frontend/package.json's `packageManager`.
    if (-not (Test-CommandOnPath 'corepack')) {
        throw "corepack not found. Your Node.js install is too old; please upgrade to Node >= 20."
    }
    Write-Step 'corepack enable'
    & corepack enable | Out-Null
    Write-Step 'corepack prepare pnpm@latest --activate'
    & corepack prepare 'pnpm@latest' --activate | Out-Null
    Update-PathFromMachine
    if (Test-CommandOnPath 'pnpm') {
        Write-Ok "pnpm activated: $(& pnpm --version)"
    } else {
        throw "pnpm still not on PATH after corepack activation. Open a new shell and re-run."
    }
} else {
    Write-Section '1. Prerequisites (skipped)'
}

# 2. Frontend --------------------------------------------------------------
if (-not $SkipFrontend) {
    Write-Section '2. Frontend dependencies (pnpm install)'
    Push-Location $frontendDir
    try {
        & pnpm install
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm install failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
    Write-Ok "Frontend dependencies installed."
} else {
    Write-Section '2. Frontend dependencies (skipped)'
}

# 3. Backend ---------------------------------------------------------------
if (-not $SkipBackend) {
    Write-Section '3. Backend CMake configure (Debug)'
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $devShell `
        "cmake -S '$repoRoot/backend' -B '$repoRoot/backend/build' -G Ninja -DCMAKE_BUILD_TYPE=Debug"
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed with exit code $LASTEXITCODE."
    }
    Write-Ok "Backend configured in backend/build."

    # Bundled MP3 encoder. The repo *should* contain backend/third_party/lame/lame.exe
    # (committed), but a fresh clone after a `lame.exe` refresh — or any clone
    # where the binary was excluded for size — may be missing it. Fetch on
    # demand so MP3 export works after a single Setup-Dev run.
    $lameExe = Join-Path $repoRoot 'backend/third_party/lame/lame.exe'
    if (-not (Test-Path -LiteralPath $lameExe)) {
        Write-Section '3a. Fetch bundled LAME encoder (lame.exe)'
        & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts/Fetch-Lame.ps1')
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Fetch-Lame.ps1 failed (exit $LASTEXITCODE). MP3 export will be unavailable." -ForegroundColor Yellow
        }
    }

    if ($BuildBackend) {
        Write-Section '3b. Backend build (Debug)'
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $devShell `
            "cmake --build '$repoRoot/backend/build' --config Debug --parallel"
        if ($LASTEXITCODE -ne 0) {
            throw "Backend build failed with exit code $LASTEXITCODE."
        }
        Write-Ok "Backend built (Debug)."
    }
} else {
    Write-Section '3. Backend CMake configure (skipped)'
}

Write-Section 'Done'
Write-Host '  Next steps:' -ForegroundColor Cyan
Write-Host '    - Open the workspace in VS Code and press F5, or' -ForegroundColor Gray
Write-Host '    - Run the "dev: all" task, or' -ForegroundColor Gray
Write-Host '    - From frontend/: pnpm dev' -ForegroundColor Gray
