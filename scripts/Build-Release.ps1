<#
.SYNOPSIS
    End-to-end Release build of Silverdaw — backend (CMake / MSVC), frontend
    (electron-vite), and a signed Windows MSIX/AppX package (electron-builder).

.DESCRIPTION
    Runs the release phases in order, aborting on the first failure:

      1. Configure + build the JUCE backend in Release.
         Output: backend/build-release/SilverdawBackend_artefacts/Release/SilverdawBackend.exe

      2. Compile the Electron main / preload / renderer bundles.
         Output: frontend/out/{main,preload,renderer}

      3. Ensure a self-signed `CN=Silverdaw` code-signing certificate exists in
         the current user's certificate store (created on first run). The
         private key stays in the store — it is NEVER exported to the repo.

      4. Package a signed MSIX/AppX that bundles the Electron runtime, the
         compiled JS bundles, the backend exe, the icons, the LICENSE and the
         third-party notices. electron-builder signs the package via signtool
         using the cert selected by subject name in electron-builder.yml.
         Output: dist/Silverdaw-<version>.appx

      5. Export the PUBLIC certificate (dist/Silverdaw-PublicCert.cer) so end
         users can trust it before sideloading, and print install instructions.

    Between phases 1 and 2 a bundling guard verifies that every runtime
    binary (*.dll / *.exe) the Release backend drops next to
    SilverdawBackend.exe is listed in the extraResources filter in
    frontend/electron-builder.yml. That filter is an allowlist, so a new
    dependency DLL would otherwise be silently dropped from the package
    and only fail at runtime on a clean machine — the guard turns that into
    a loud, early build failure.

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

# Release builds get their own CMake build directory so we never clobber the
# Debug cache that VS Code's `backend: build` task relies on. Ninja is a
# single-config generator — sharing a build dir with Debug means whichever
# configure ran last wins, and the other config silently gets the wrong
# artefact. The Release artefacts land under `SilverdawBackend_artefacts/Release`.
$backendBuildDir     = Join-Path $backendDir 'build-release'
$backendArtefactsDir = Join-Path $backendBuildDir 'SilverdawBackend_artefacts\Release'

function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host ("  $Title") -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor Cyan
}

# Parse the backend extraResources `filter:` allowlist out of the
# electron-builder.yml so the guard below stays in sync with whatever the
# installer actually ships — no second hand-maintained list to drift.
function Get-BundledBackendFilter([string]$YmlPath) {
    $allow = New-Object System.Collections.Generic.List[string]
    $inBackendEntry = $false
    $inFilter = $false
    foreach ($line in (Get-Content -LiteralPath $YmlPath)) {
        if ($line -match '^\s*-\s*from:\s*(.+?)\s*$') {
            # A new extraResources list item — are we entering the backend one?
            $inBackendEntry = $matches[1] -like '*backend/build-release*'
            $inFilter = $false
            continue
        }
        if ($inBackendEntry -and $line -match '^\s*filter:\s*$') {
            $inFilter = $true
            continue
        }
        if ($inFilter) {
            if ($line -match '^\s*#') { continue }          # comment in the list
            elseif ($line -match '^\s*$') { continue }        # blank line
            elseif ($line -match '^\s*-\s*([^\s#]+)\s*$') { $allow.Add($matches[1]) }
            else { $inFilter = $false; $inBackendEntry = $false }  # dedent ends it
        }
    }
    return $allow
}

# Fail the build if the Release backend emitted any runtime binary the
# installer filter wouldn't carry.
function Assert-BackendArtefactsBundled([string]$ArtefactsDir, [string]$YmlPath) {
    if (-not (Test-Path $ArtefactsDir)) {
        throw "Bundling guard: backend Release artefacts not found at $ArtefactsDir (build the backend first, or drop -SkipBackend)."
    }
    if (-not (Test-Path $YmlPath)) {
        throw "Bundling guard: electron-builder config not found at $YmlPath."
    }
    $allow = Get-BundledBackendFilter -YmlPath $YmlPath
    if ($allow.Count -eq 0) {
        throw "Bundling guard: parsed zero filter entries from $YmlPath — the backend extraResources block may have moved. Fix the parser before shipping."
    }
    $shipped = Get-ChildItem -LiteralPath $ArtefactsDir -File |
        Where-Object { $_.Extension -in '.dll', '.exe' }
    $unlisted = $shipped | Where-Object { $allow -notcontains $_.Name }
    if ($unlisted) {
        $names = ($unlisted | ForEach-Object { $_.Name }) -join ', '
        throw @"
Bundling guard FAILED — the installer would ship an incomplete backend.

These runtime binaries sit next to SilverdawBackend.exe but are NOT in the
extraResources filter in frontend/electron-builder.yml, so the packaged app
would be missing them on a clean machine:

    $names

Fix: add each filename to that filter (or, if it is genuinely not needed at
runtime, exclude it deliberately and note why).

  Artefacts : $ArtefactsDir
  Allowlist : $($allow -join ', ')
"@
    }
    $shippedNames = ($shipped | ForEach-Object { $_.Name }) -join ', '
    Write-Host "Bundling guard OK — all $($shipped.Count) backend binaries are covered by the installer filter ($shippedNames)." -ForegroundColor Green
}

# Ensure a self-signed code-signing certificate with Subject `CN=Silverdaw`
# exists in the current user's `My` store, creating it on first run. The
# private key lives only in the certificate store and is marked
# non-exportable, so no key material is ever written into the repository.
# electron-builder's `signtoolOptions.certificateSubjectName: Silverdaw`
# picks this cert up by subject name at signing time. Returns the cert object.
function Get-SilverdawSigningCert {
    $subject = 'CN=Silverdaw'
    $codeSigningEku = '1.3.6.1.5.5.7.3.3'
    $now = Get-Date
    $existing = Get-ChildItem -Path Cert:\CurrentUser\My |
        Where-Object {
            $_.Subject -eq $subject -and
            $_.NotAfter -gt $now -and
            ($_.EnhancedKeyUsageList.ObjectId -contains $codeSigningEku)
        } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1

    if ($existing) {
        Write-Host "Reusing existing signing cert (thumbprint $($existing.Thumbprint), expires $($existing.NotAfter.ToString('yyyy-MM-dd')))."
        return $existing
    }

    Write-Host "No '$subject' signing cert found — creating a self-signed one (valid 3 years)."
    return New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $subject `
        -FriendlyName 'Silverdaw self-signed code signing' `
        -KeyUsage DigitalSignature `
        -KeyExportPolicy NonExportable `
        -CertStoreLocation Cert:\CurrentUser\My `
        -NotAfter $now.AddYears(3)
}

# electron-builder 26.x bundles an old signtool.exe (winCodeSign-2.6.0) that
# can sign plain executables but NOT MSIX/AppX packages — it fails with
# "SignTool Error: A required function is not present." The modern signtool
# from the installed Windows 10/11 SDK does support AppX, so we point
# electron-builder at it via the SIGNTOOL_PATH env var it honours. Returns the
# newest x64 SDK signtool.exe, or $null if the SDK is not installed.
function Get-SdkSignToolPath {
    $roots = @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")
    $candidates = foreach ($r in $roots) {
        if (Test-Path $r) {
            Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^10\.' } |
                Sort-Object { [version]$_.Name } -Descending |
                ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' }
        }
    }
    return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

# 1. Backend ---------------------------------------------------------------
if (-not $SkipBackend) {
    Write-Section 'Backend: configure (Release)'
    & $devShell "cmake -S `"$backendDir`" -B `"$backendBuildDir`" -G Ninja -DCMAKE_BUILD_TYPE=Release"
    if ($LASTEXITCODE -ne 0) { throw "Backend configure failed (exit $LASTEXITCODE)" }

    Write-Section 'Backend: build (Release)'
    & $devShell "cmake --build `"$backendBuildDir`" --parallel"
    if ($LASTEXITCODE -ne 0) { throw "Backend build failed (exit $LASTEXITCODE)" }

    $backendExe = Join-Path $backendArtefactsDir 'SilverdawBackend.exe'
    if (-not (Test-Path $backendExe)) {
        throw "Backend exe not found at $backendExe after a successful build"
    }
    Write-Host "Backend exe: $backendExe"
} else {
    Write-Host 'Skipping backend build (--SkipBackend).' -ForegroundColor Yellow
}

# 1b. Bundling guard -------------------------------------------------------
# Verify every runtime binary the backend drops next to the exe is covered by
# the installer's extraResources allowlist before we spend time packaging.
Write-Section 'Verify: backend binaries covered by installer filter'
Assert-BackendArtefactsBundled $backendArtefactsDir (Join-Path $frontendDir 'electron-builder.yml')

# 2. Frontend deps + bundles ----------------------------------------------
Push-Location $frontendDir
try {
    if (-not $SkipFrontendInstall) {
        Write-Section 'Frontend: pnpm install'
        pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
    }

    # 3. Signing certificate --------------------------------------------
    # Provision the self-signed CN=Silverdaw cert before packaging so
    # electron-builder can sign the MSIX (and the exes it wraps) via signtool.
    Write-Section 'Sign: ensure self-signed CN=Silverdaw certificate'
    $signingCert = Get-SilverdawSigningCert

    # Force electron-builder to use the modern Windows SDK signtool — its
    # bundled one cannot sign AppX packages (see Get-SdkSignToolPath).
    $sdkSignTool = Get-SdkSignToolPath
    if (-not $sdkSignTool) {
        throw "MSIX signing needs the Windows 10/11 SDK signtool.exe, which was not found under 'Windows Kits\10\bin'. Install the Windows SDK (it ships with the Visual Studio C++ workload used to build the backend)."
    }
    $env:SIGNTOOL_PATH = $sdkSignTool
    Write-Host "Using SDK signtool: $sdkSignTool"

    # 4. Bundles + MSIX package (electron-vite + electron-builder) --------
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

    Write-Section 'Frontend: build bundles + signed MSIX package'
    # Wipe the previous `dist/` outputs so each release is a clean build —
    # avoids stale `win-unpacked/` files lingering when source files are
    # renamed/removed between builds, and guarantees the package we
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

# 5. Export the public certificate ----------------------------------------
# The .cer is the public half only (no private key) — safe to distribute so
# users can trust the package before sideloading. dist/ is gitignored.
Write-Section 'Sign: export public certificate for users to trust'
$publicCertPath = Join-Path $repoRoot 'dist\Silverdaw-PublicCert.cer'
Export-Certificate -Cert $signingCert -FilePath $publicCertPath -Type CERT -Force | Out-Null
Write-Host "Public cert: $publicCertPath"

# Report what we produced -------------------------------------------------
Write-Section 'Done'
$package = Get-ChildItem -Path (Join-Path $repoRoot 'dist') -Filter 'Silverdaw-*.appx' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($package) {
    Write-Host ("Package: {0} ({1:N1} MB)" -f $package.FullName, ($package.Length / 1MB)) -ForegroundColor Green
    Write-Host ''
    Write-Host 'To install on a clean machine (self-signed — trust the cert first):' -ForegroundColor Cyan
    Write-Host '  # 1. Trust the publisher (one-time, elevated PowerShell). A self-signed'
    Write-Host '  #    cert is its own root, so it must go in the Trusted Root store for'
    Write-Host '  #    the App Installer GUI to enable Install (Add-AppxPackage also accepts it):'
    Write-Host "  Import-Certificate -FilePath '$publicCertPath' -CertStoreLocation Cert:\LocalMachine\Root"
    Write-Host '  # 2. Install the package:'
    Write-Host ("  Add-AppxPackage -Path '{0}'" -f $package.FullName)
    Write-Host '  # (Or double-click the .appx to use the App Installer UI.)'
} else {
    Write-Warning "No .appx package found under $repoRoot/dist."
}
