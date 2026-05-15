<#
.SYNOPSIS
    Lint the Rook backend C++ sources with clang-tidy.

.DESCRIPTION
    Runs clang-tidy over every *.cpp under backend/src/ using the
    compile_commands.json produced by the CMake configure step
    (CMAKE_EXPORT_COMPILE_COMMANDS=ON). Checks are controlled by
    backend/.clang-tidy.

    Intended to be invoked from inside the Visual Studio developer shell
    (see Invoke-DevShell.ps1) so the clang-tidy that ships with the
    "C++ Clang tools for Windows" component is on PATH. If clang-tidy is
    not found, the script prints an actionable message and exits 2.

.PARAMETER Fix
    Pass --fix to clang-tidy so suggested code-mods are applied in place.
    Pair this with clang-format afterwards to tidy up resulting whitespace.

.PARAMETER Strict
    Treat every warning as an error (clang-tidy --warnings-as-errors=*).
    Useful for CI; off by default so a fresh `backend: lint` run is
    informative rather than immediately failing.

.PARAMETER BuildDir
    The CMake build directory containing compile_commands.json. Defaults
    to <repo>/backend/build (matches the VS Code build tasks).

.PARAMETER SrcDir
    The directory to scan for *.cpp files. Defaults to <repo>/backend/src.
#>
[CmdletBinding()]
param(
    [switch]$Fix,
    [switch]$Strict,
    [string]$BuildDir = (Join-Path $PSScriptRoot '..\backend\build'),
    [string]$SrcDir = (Join-Path $PSScriptRoot '..\backend\src')
)

$ErrorActionPreference = 'Stop'

$BuildDir = (Resolve-Path -LiteralPath $BuildDir -ErrorAction SilentlyContinue)?.Path
$SrcDir = (Resolve-Path -LiteralPath $SrcDir).Path

$compileDb = if ($BuildDir) { Join-Path $BuildDir 'compile_commands.json' } else { $null }
if (-not $compileDb -or -not (Test-Path -LiteralPath $compileDb)) {
    Write-Host "compile_commands.json not found under '$BuildDir'." -ForegroundColor Yellow
    Write-Host "Run the 'backend: configure' task first so CMake generates it." -ForegroundColor Yellow
    exit 2
}

function Find-ClangTidy {
    $cmd = Get-Command clang-tidy -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # Fall back to the copy that ships with the VS "C++ Clang tools for
    # Windows" component, so the script also works from a plain shell that
    # hasn't sourced the VS dev environment.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { return $null }

    $vsPath = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if (-not $vsPath) { return $null }

    $candidate = Join-Path $vsPath 'VC\Tools\Llvm\x64\bin\clang-tidy.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    return $null
}

$clangTidyExe = Find-ClangTidy
if (-not $clangTidyExe) {
    Write-Host 'clang-tidy was not found on PATH or in the latest Visual Studio install.' -ForegroundColor Yellow
    Write-Host 'Install the "C++ Clang tools for Windows" individual component via' -ForegroundColor Yellow
    Write-Host 'the Visual Studio Installer, or install standalone LLVM (winget' -ForegroundColor Yellow
    Write-Host 'install LLVM.LLVM) and ensure clang-tidy.exe is on PATH.' -ForegroundColor Yellow
    exit 2
}

$files = Get-ChildItem -Path $SrcDir -Recurse -Include '*.cpp' |
    Select-Object -ExpandProperty FullName

if ($files.Count -eq 0) {
    Write-Host "No .cpp files found under '$SrcDir'." -ForegroundColor Yellow
    exit 0
}

Write-Host "clang-tidy: $clangTidyExe"
Write-Host "compile DB: $compileDb"
Write-Host "Linting $($files.Count) file(s)..."

$tidyArgs = @('-p', $BuildDir, '--quiet')
if ($Fix) { $tidyArgs += '--fix' }
if ($Strict) { $tidyArgs += '--warnings-as-errors=*' }
$tidyArgs += $files

& $clangTidyExe @tidyArgs
exit $LASTEXITCODE
