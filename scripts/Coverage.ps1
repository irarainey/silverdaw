<#
.SYNOPSIS
    Generate code-coverage reports for the Silverdaw frontend and/or backend and
    collect the viewable reports into a single gitignored coverage/ folder.

.DESCRIPTION
    Frontend: runs Vitest with the v8 coverage provider (config lives in
    frontend/vitest.config.ts).
    Backend: runs the already-built SilverdawBackendTests.exe under
    OpenCppCoverage (needs a Debug build with PDBs). OpenCppCoverage returns a
    benign breakpoint stop code on JUCE Debug builds; a written report is
    treated as success.

    Whichever side(s) run, the HTML report is copied into a single, root-level,
    gitignored folder:
        coverage/frontend/index.html
        coverage/backend/index.html
        coverage/index.html          (landing page linking both)

    Requires: pnpm (frontend); OpenCppCoverage on PATH or under Program Files
    (backend, install via `winget install OpenCppCoverage.OpenCppCoverage`).

.PARAMETER Target
    Which side to cover: All (default), Frontend, or Backend.

.PARAMETER BuildDir
    Backend CMake build directory (default: backend/build).

.EXAMPLE
    ./scripts/Coverage.ps1                 # both
    ./scripts/Coverage.ps1 -Target Frontend
#>
[CmdletBinding()]
param(
    [ValidateSet('All', 'Frontend', 'Backend')]
    [string]$Target = 'All',
    [string]$BuildDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $BuildDir) { $BuildDir = Join-Path $repoRoot 'backend/build' }

$coverageRoot = Join-Path $repoRoot 'coverage'

function Copy-Report {
    param([string]$Source, [string]$DestName)
    $dest = Join-Path $coverageRoot $DestName
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path (Join-Path $Source '*') -Destination $dest -Recurse -Force
}

function Invoke-FrontendCoverage {
    Write-Host '== Frontend coverage (Vitest v8) ==' -ForegroundColor Cyan
    Push-Location (Join-Path $repoRoot 'frontend')
    try {
        # Pipe to Out-Host so pnpm's stdout is displayed but does NOT leak into
        # this function's return value (PowerShell returns all output-stream
        # objects, and a bare `& pnpm` would return its console output).
        & pnpm test:coverage | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "frontend coverage failed ($LASTEXITCODE)" }
    }
    finally { Pop-Location }

    # The v8 html reporter writes the full report tree here.
    Copy-Report -Source (Join-Path $repoRoot 'frontend/coverage') -DestName 'frontend'

    $pct = $null
    $summary = Join-Path $repoRoot 'frontend/coverage/coverage-summary.json'
    if (Test-Path $summary) {
        $pct = (Get-Content $summary -Raw | ConvertFrom-Json).total.lines.pct
    }
    Write-Host "Frontend line coverage: $pct%" -ForegroundColor Green
    return $pct
}

function Invoke-BackendCoverage {
    Write-Host '== Backend coverage (OpenCppCoverage) ==' -ForegroundColor Cyan

    $exe = Join-Path $BuildDir 'SilverdawBackendTests.exe'
    if (-not (Test-Path $exe)) {
        throw "Test binary not found: $exe`nBuild it first from a Developer prompt: cmake --build `"$BuildDir`" --target SilverdawBackendTests"
    }

    $occ = Get-Command OpenCppCoverage -ErrorAction SilentlyContinue
    if (-not $occ) {
        $occ = Get-ChildItem 'C:/Program Files/OpenCppCoverage','C:/Program Files (x86)/OpenCppCoverage' `
            -Filter OpenCppCoverage.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $occ) {
        throw 'OpenCppCoverage not found. Install: winget install OpenCppCoverage.OpenCppCoverage'
    }
    $occPath = if ($occ -is [System.Management.Automation.CommandInfo]) { $occ.Source } else { $occ.FullName }

    $outDir = Join-Path $repoRoot 'backend/build-coverage'
    $html = Join-Path $outDir 'html'
    $cobertura = Join-Path $outDir 'cobertura.xml'
    $srcNative = (Join-Path $repoRoot 'backend/src') -replace '/', '\'
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    # OpenCppCoverage returns the debuggee stop code (benign breakpoint under
    # JUCE Debug); success is judged by the report being written.
    & $occPath --quiet `
        --sources $srcNative `
        --excluded_sources 'tests' --excluded_sources '_deps' --excluded_sources 'third_party' `
        --modules 'SilverdawBackendTests.exe' `
        --export_type "html:$html" `
        --export_type "cobertura:$cobertura" `
        -- $exe | Out-Null

    if (-not (Test-Path $cobertura)) { throw 'OpenCppCoverage produced no report' }

    Copy-Report -Source $html -DestName 'backend'

    # OpenCppCoverage's index.html lists a "total" row plus one row per module;
    # with a single module those are identical, so it looks duplicated. Redirect
    # the backend entry straight to the useful per-file module page instead.
    $modulePage = Get-ChildItem (Join-Path $coverageRoot 'backend/Modules') -Filter *.html -File `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($modulePage) {
        $redirect = "<!doctype html><meta charset=""utf-8"">" +
            "<meta http-equiv=""refresh"" content=""0; url=Modules/$($modulePage.Name)"">" +
            "<title>Backend coverage</title>" +
            "<a href=""Modules/$($modulePage.Name)"">Backend coverage report</a>"
        Set-Content -Path (Join-Path $coverageRoot 'backend/index.html') -Value $redirect -Encoding utf8
    }

    [xml]$xml = Get-Content $cobertura
    $pct = [math]::Round([double]$xml.coverage.'line-rate' * 100, 1)
    Write-Host "Backend line coverage: $pct%" -ForegroundColor Green
    return $pct
}

function Write-LandingPage {
    param($FrontendPct, $BackendPct)
    $rows = ''
    if (Test-Path (Join-Path $coverageRoot 'frontend/index.html')) {
        $rows += "<li><a href=""frontend/index.html"">Frontend (Vitest)</a> &mdash; $FrontendPct% lines</li>`n"
    }
    if (Test-Path (Join-Path $coverageRoot 'backend/index.html')) {
        $rows += "<li><a href=""backend/index.html"">Backend (OpenCppCoverage)</a> &mdash; $BackendPct% lines</li>`n"
    }
    $html = @"
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Silverdaw coverage</title>
<style>body{font-family:system-ui,sans-serif;background:#18181b;color:#e4e4e7;margin:3rem auto;max-width:40rem}
a{color:#38bdf8}h1{font-weight:600}li{margin:.5rem 0}small{color:#a1a1aa}</style></head>
<body><h1>Silverdaw coverage</h1><ul>
$rows</ul><small>Generated by scripts/Coverage.ps1 &mdash; this folder is gitignored.</small></body></html>
"@
    Set-Content -Path (Join-Path $coverageRoot 'index.html') -Value $html -Encoding utf8
}

New-Item -ItemType Directory -Force -Path $coverageRoot | Out-Null
$frontendPct = $null
$backendPct = $null
if ($Target -in 'All', 'Frontend') { $frontendPct = Invoke-FrontendCoverage }
if ($Target -in 'All', 'Backend') { $backendPct = Invoke-BackendCoverage }
Write-LandingPage -FrontendPct $frontendPct -BackendPct $backendPct

Write-Host ''
Write-Host "Combined report: $(Join-Path $coverageRoot 'index.html')" -ForegroundColor Green
