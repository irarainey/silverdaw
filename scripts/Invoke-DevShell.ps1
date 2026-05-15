<#
.SYNOPSIS
    Runs a command inside the latest Visual Studio Developer Shell.

.DESCRIPTION
    Locates the most recent Visual Studio install with the C++ workload via
    vswhere, imports Microsoft.VisualStudio.DevShell.dll so cl.exe / cmake /
    ninja / lib / link are all on PATH for the x64 toolchain, then runs the
    supplied command line.

    Used by .vscode/tasks.json so VS Code tasks build correctly regardless of
    how VS Code itself was launched.

.PARAMETER CommandLine
    The command (and its arguments) to execute, as a single string. Example:
        pwsh -File Invoke-DevShell.ps1 "cmake --build backend/build --config Debug --parallel"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$CommandLine
)

$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) {
    throw @"
vswhere.exe not found at '$vswhere'.
Install the MSVC toolchain via either:
  - Build Tools for Visual Studio (standalone, no IDE) with the 'C++ build tools' workload, or
  - Visual Studio (any edition) with the 'Desktop development with C++' workload.
Quick install (winget):
  winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
"@
}

$vsPath = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath

if (-not $vsPath) {
    throw @'
No MSVC toolchain was found (component Microsoft.VisualStudio.Component.VC.Tools.x86.x64).
Install one of:
  - Build Tools for Visual Studio (standalone, no IDE) with the 'C++ build tools' workload, or
  - Visual Studio (any edition) with the 'Desktop development with C++' workload.
If VS or Build Tools is already installed, run the VS Installer and Modify the install to add that workload.
Quick install (winget):
  winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
'@
}

$devShellDll = Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
if (-not (Test-Path $devShellDll)) {
    throw "DevShell module not found at '$devShellDll'."
}

Import-Module $devShellDll
Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation `
    -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null

Invoke-Expression $CommandLine
exit $LASTEXITCODE
