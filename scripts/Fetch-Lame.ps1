<#
.SYNOPSIS
    Download and verify the LAME encoder/decoder and its required decoder DLL.

.DESCRIPTION
    Silverdaw ships an unmodified Windows build of the LAME MP3 encoder
    next to SilverdawBackend.exe for MP3 import and export. LAME 4 also
    requires libmpg123-0.dll alongside it. Both files live at:

        backend/third_party/lame/lame.exe
        backend/third_party/lame/libmpg123-0.dll

    and are deliberately *not* committed, so the repository stays free of
    vendored binaries. Documentation and licensing notices are tracked; a
    fresh checkout — a CI runner's included — must run this script before a
    build that needs MP3 support. `Setup-Dev.ps1` calls it on demand.

    The default upstream is the RareWares LAME bundle — the standard
    Windows distribution recommended by the LAME project. Because that
    URL changes when LAME ships a new build, you can override it with
    `-Url` and `-Sha256`. A ZIP containing both runtime files is required;
    standalone executable downloads are no longer sufficient.

    The default archive has a pinned SHA-256. Custom URLs require an explicit
    hash. The staged executable is checked before either runtime file is
    installed.

    A complete LAME 4.0 installation is retained unless `-Force` is given.
    Old or incomplete installations are refreshed automatically.

.PARAMETER Url
    ZIP archive containing lame.exe and a sibling libmpg123-0.dll.
    Default: the standard RareWares LAME 4.0 x64 bundle, not its q4 variant.

.PARAMETER Sha256
    SHA-256 of the archive. Required for custom URLs; pinned for the default.

.PARAMETER Force
    Refresh both files even when a complete LAME 4.0 installation is present.

.PARAMETER ZipEntry
    When `-Url` points to a `.zip`, the path inside the archive to
    extract. Without this option exactly one lame.exe must exist in the
    archive. Its decoder DLL must be in the same directory.

.EXAMPLE
    # Standard one-shot fetch.
    pwsh scripts\Fetch-Lame.ps1

.EXAMPLE
    # Refresh with a specific URL + hash pin.
    pwsh scripts\Fetch-Lame.ps1 `
        -Url 'https://www.rarewares.org/files/mp3/lame-4.0-x64.zip' `
        -Sha256 '722f4311e2795d5c852076a579b3183beeb76e9010d9cab1e7f9d2e86d9d0808' -Force

.NOTES
    LAME is LGPL-2.1-or-later; libmpg123 is LGPL-2.1. Only LAME links
    the decoder DLL; Silverdaw invokes LAME as a child process.
    See `THIRD_PARTY_LICENSES.md` and
    `backend/third_party/lame/README.md` for the full attribution and
    legal notes.
#>
[CmdletBinding()]
param(
    [string]$Url = 'https://www.rarewares.org/files/mp3/lame-4.0-x64.zip',
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$Sha256,
    [switch]$Force,
    [string]$ZipEntry
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Resolve repo paths relative to the script so the helper works from any cwd.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$LameDir   = Join-Path $RepoRoot 'backend\third_party\lame'
$LameExe   = Join-Path $LameDir  'lame.exe'
$DecoderDll = Join-Path $LameDir 'libmpg123-0.dll'
$DefaultUrl = 'https://www.rarewares.org/files/mp3/lame-4.0-x64.zip'
$ExpectedVersionPattern = '^LAME\b.*\bversion 4\.0(?:\s|$)'

if ($Url -notmatch '\.zip(\?|$)') {
    throw 'LAME 4 requires a ZIP bundle containing lame.exe and libmpg123-0.dll.'
}
if (-not $Sha256) {
    if ($Url -ne $DefaultUrl) {
        throw 'A custom -Url requires -Sha256.'
    }
    $Sha256 = '722f4311e2795d5c852076a579b3183beeb76e9010d9cab1e7f9d2e86d9d0808'
}

function Get-LameVersion([string]$Executable) {
    $global:LASTEXITCODE = 0
    $output = @(& $Executable --version 2>&1)
    if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) {
        throw "lame.exe version check failed (exit $LASTEXITCODE): $output"
    }
    $version = [string]$output[0]
    if ($version -notmatch '^LAME\b.*\bversion \d') {
        throw "Unrecognised LAME version output: $version"
    }
    return $version
}

if (-not (Test-Path -LiteralPath $LameDir)) {
    throw "Expected drop folder not found: $LameDir"
}

if ((Test-Path -LiteralPath $LameExe -PathType Leaf) -and
    (Test-Path -LiteralPath $DecoderDll -PathType Leaf) -and -not $Force) {
    $version = Get-LameVersion $LameExe
    if ($version -match $ExpectedVersionPattern) {
        Write-Host "LAME bundle already present at $LameDir - use -Force to refresh." -ForegroundColor Yellow
        Write-Host $version -ForegroundColor Cyan
        return
    }
    Write-Host "Refreshing old LAME installation: $version" -ForegroundColor Yellow
}

# Validate both staged files before replacing the installed runtime.
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("silverdaw-lame-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    $dlPath = Join-Path $tempRoot 'lame-bundle.zip'

    Write-Host "Downloading $Url" -ForegroundColor Cyan
    # Invoke-WebRequest honours $ProgressPreference; silence the verbose
    # progress bar so CI logs stay readable.
    $prev = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $Url -OutFile $dlPath -UseBasicParsing
    } finally {
        $ProgressPreference = $prev
    }

    $actual = (Get-FileHash -LiteralPath $dlPath -Algorithm SHA256).Hash
    if ($actual -ine $Sha256) {
        throw "SHA-256 mismatch.`n  expected: $Sha256`n  actual:   $actual"
    }
    Write-Host "SHA-256 verified." -ForegroundColor Green

    $extractDir = Join-Path $tempRoot 'extracted'
    Expand-Archive -LiteralPath $dlPath -DestinationPath $extractDir -Force
    if ($ZipEntry) {
        $sourceExe = [System.IO.Path]::GetFullPath((Join-Path $extractDir $ZipEntry))
        if (-not $sourceExe.StartsWith("$extractDir\", [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $sourceExe -PathType Leaf) -or
            [System.IO.Path]::GetFileName($sourceExe) -ine 'lame.exe') {
            throw "Specified -ZipEntry '$ZipEntry' must name a lame.exe inside the archive."
        }
    } else {
        $executables = @(Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'lame.exe' -File)
        if ($executables.Count -ne 1) {
            throw "Archive must contain exactly one lame.exe; use -ZipEntry to select a build."
        }
        $sourceExe = $executables[0].FullName
    }

    $sourceDll = Join-Path (Split-Path -Parent $sourceExe) 'libmpg123-0.dll'
    if (-not (Test-Path -LiteralPath $sourceDll -PathType Leaf)) {
        throw 'Archive is missing libmpg123-0.dll next to the selected lame.exe.'
    }
    $version = Get-LameVersion $sourceExe
    if ($version -notmatch $ExpectedVersionPattern) {
        throw "Expected LAME 4.0; got: $version"
    }
    Copy-Item -LiteralPath $sourceDll -Destination $DecoderDll -Force
    Copy-Item -LiteralPath $sourceExe -Destination $LameExe -Force
    Write-Host "Installed LAME and libmpg123 at $LameDir" -ForegroundColor Green
    Write-Host $version -ForegroundColor Cyan
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
