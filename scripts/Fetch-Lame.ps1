<#
.SYNOPSIS
    Download (and verify) the bundled lame.exe used by Silverdaw's MP3
    export feature.

.DESCRIPTION
    Silverdaw ships an unmodified Windows build of the LAME MP3 encoder
    next to SilverdawBackend.exe. JUCE's `LAMEEncoderAudioFormat` spawns
    it as a child process at export time. The binary lives at:

        backend/third_party/lame/lame.exe

    and is *committed* to the repo so end users get working MP3 export
    with no extra install step. This script fetches a fresh copy on
    demand (e.g., on a brand-new checkout, or when refreshing to a newer
    LAME release).

    The default upstream is the RareWares LAME bundle — the standard
    Windows distribution recommended by the LAME project. Because that
    URL changes when LAME ships a new build, you can override it with
    `-Url`. The script supports either a direct `.exe` download or a
    `.zip` archive that contains `lame.exe` somewhere inside it.

    If `-Sha256` is supplied the downloaded payload is verified against
    that hash before extraction. After installation the script runs
    `lame.exe --version` as a sanity check.

    Re-running is safe: if `lame.exe` is already present the script
    no-ops unless `-Force` is given.

.PARAMETER Url
    Direct URL to either a `lame.exe` binary or a `.zip` archive
    containing one. Default: the current RareWares LAME 3.100 x64
    bundle.

.PARAMETER Sha256
    Optional SHA-256 hash of the downloaded file (the .exe or .zip,
    matching `-Url`). When supplied the script aborts on mismatch.

.PARAMETER Force
    Overwrite an existing `lame.exe`. Without this switch the script
    keeps whatever is already on disk and exits early.

.PARAMETER ZipEntry
    When `-Url` points to a `.zip`, the path inside the archive to
    extract (default: searches for any `lame.exe` and uses the first
    match). Useful for archives that contain multiple builds.

.EXAMPLE
    # Standard one-shot fetch.
    pwsh scripts\Fetch-Lame.ps1

.EXAMPLE
    # Refresh with a specific URL + hash pin.
    pwsh scripts\Fetch-Lame.ps1 `
        -Url 'https://www.rarewares.org/files/mp3/lame3.100.1-x64.zip' `
        -Sha256 'abcd…' -Force

.NOTES
    LAME is LGPL-2.1-or-later. We invoke it as a child process; there is
    no static or dynamic linking. See `THIRD_PARTY_LICENSES.md` and
    `backend/third_party/lame/README.md` for the full attribution and
    legal notes.
#>
[CmdletBinding()]
param(
    [string]$Url = 'https://www.rarewares.org/files/mp3/lame3.100.1-x64.zip',
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

if (-not (Test-Path -LiteralPath $LameDir)) {
    throw "Expected drop folder not found: $LameDir"
}

if ((Test-Path -LiteralPath $LameExe) -and -not $Force) {
    Write-Host "lame.exe already present at $LameExe — use -Force to overwrite." -ForegroundColor Yellow
    & $LameExe --version 2>&1 | Select-Object -First 1
    return
}

# Stage downloads in TEMP so a failed fetch never half-overwrites the
# tracked binary in the repo.
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("silverdaw-lame-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    $isZip = $Url -match '\.zip(\?|$)'
    $dlName = if ($isZip) { 'lame-bundle.zip' } else { 'lame.exe' }
    $dlPath = Join-Path $tempRoot $dlName

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

    if ($Sha256) {
        $actual = (Get-FileHash -LiteralPath $dlPath -Algorithm SHA256).Hash
        if ($actual -ine $Sha256) {
            throw "SHA-256 mismatch.`n  expected: $Sha256`n  actual:   $actual"
        }
        Write-Host "SHA-256 verified." -ForegroundColor Green
    } else {
        Write-Host "No -Sha256 supplied; skipping hash verification." -ForegroundColor Yellow
    }

    $sourceExe = $null
    if ($isZip) {
        $extractDir = Join-Path $tempRoot 'extracted'
        Expand-Archive -LiteralPath $dlPath -DestinationPath $extractDir -Force

        if ($ZipEntry) {
            $candidate = Join-Path $extractDir $ZipEntry
            if (-not (Test-Path -LiteralPath $candidate)) {
                throw "Specified -ZipEntry '$ZipEntry' not found in archive."
            }
            $sourceExe = $candidate
        } else {
            $match = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'lame.exe' -File | Select-Object -First 1
            if (-not $match) {
                throw "Archive did not contain a lame.exe. Use -ZipEntry to point at a specific path."
            }
            $sourceExe = $match.FullName
        }
    } else {
        $sourceExe = $dlPath
    }

    Copy-Item -LiteralPath $sourceExe -Destination $LameExe -Force
    Write-Host "Installed $LameExe" -ForegroundColor Green

    # Sanity-check the binary actually runs (catches accidental 0-byte
    # downloads, wrong-architecture binaries, etc.). Reset $LASTEXITCODE
    # first because Set-StrictMode trips on accessing it when no native
    # command has run in this session yet.
    $global:LASTEXITCODE = 0
    $version = & $LameExe --version 2>&1 | Select-Object -First 1
    if ($LASTEXITCODE -ne 0) {
        throw "lame.exe ran but exited with code $LASTEXITCODE. Output: $version"
    }
    Write-Host $version -ForegroundColor Cyan
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
