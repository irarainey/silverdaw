<#
.SYNOPSIS
    Install a virtual audio output device so playback can be exercised on a
    machine with no sound hardware (CI runners in particular).

.DESCRIPTION
    Silverdaw's playhead is advanced by `MasterClockSource` from inside the
    audio device callback. With no output device JUCE never opens one, the
    callback never fires, and the transport cannot move — the renderer knows
    this and disables Play with a "No audio output available" tooltip. That
    makes the end-to-end playback journey (J17) impossible on a stock
    GitHub-hosted Windows runner, which ships with no audio endpoint and with
    the Windows Audio service stopped.

    This script installs Scream, an open-source virtual sound card, which
    presents a normal WASAPI render endpoint that discards whatever it is
    given. That is enough for JUCE to open a device and start its callback.

    Kernel-mode drivers will not install unless their catalogue is signed by a
    certificate the machine trusts, and Scream's published signature has
    expired. The script therefore mints a throwaway self-signed code-signing
    certificate, re-signs `Scream.cat` with it, and trusts that certificate in
    both `Root` (so the chain validates) and `TrustedPublisher` (so the install
    is non-interactive). The certificate lives and dies with the runner.

    This is intended for ephemeral, disposable machines. It installs an
    unattended kernel driver and trusts a locally-generated root certificate,
    neither of which belongs on a developer workstation.

.PARAMETER Version
    Scream release to install. Default: 4.0.

.PARAMETER Force
    Reinstall even when a working audio render endpoint is already present.

.PARAMETER AllowLocal
    Permit the script to run on a machine that is not a CI runner. Without it
    the script refuses outside CI, so it cannot be run against a workstation by
    accident.

.EXAMPLE
    pwsh -NoProfile -File scripts/Install-VirtualAudioDevice.ps1
#>
[CmdletBinding()]
param(
    [string] $Version = '4.0',
    [switch] $Force,
    [switch] $AllowLocal
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This installs an unattended kernel-mode driver and trusts a locally-minted
# root certificate. That bargain is only acceptable on a machine that is
# destroyed at the end of the job, so refuse anywhere else rather than leaving
# it to whoever reads the documentation.
if ($env:CI -ne 'true' -and -not $AllowLocal) {
    # Write-Host plus an explicit exit rather than Write-Error: with
    # $ErrorActionPreference = 'Stop' the latter terminates the script before
    # `exit 1` runs, and pwsh then reports success — a refusal that CI would
    # read as a pass.
    Write-Host @'
Refusing to run: this installs a kernel-mode audio driver and trusts a
self-signed root certificate, which is only appropriate on a disposable CI
runner. GitHub Actions sets CI=true. Pass -AllowLocal to override.
'@ -ForegroundColor Red
    exit 1
}

function Write-Step { param([string] $Message) Write-Host "==> $Message" -ForegroundColor Cyan }

# A render endpoint that is present and started. `Get-PnpDevice` is used rather
# than enumerating MMDevice endpoints because it needs no COM interop and
# reports the driver state, which is what actually fails here.
function Test-AudioEndpoint {
    $devices = Get-PnpDevice -Class 'MEDIA' -Status 'OK' -ErrorAction SilentlyContinue
    return ($null -ne $devices) -and (@($devices).Count -gt 0)
}

if (-not $Force -and (Test-AudioEndpoint)) {
    Write-Step 'An audio device is already present and healthy; nothing to do.'
    exit 0
}

# The audio service is stopped on a stock runner image. Without it the driver
# installs but no endpoint is ever published, which fails much later and much
# less legibly.
Write-Step 'Starting the Windows Audio services'
foreach ($service in 'audiosrv', 'AudioEndpointBuilder') {
    Set-Service -Name $service -StartupType Automatic
    if ((Get-Service -Name $service).Status -ne 'Running') { Start-Service -Name $service }
}

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) 'silverdaw-virtual-audio'
if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
New-Item -ItemType Directory -Path $workDir | Out-Null

$archive = Join-Path $workDir 'Scream.zip'
$url = "https://github.com/duncanthrax/scream/releases/download/$Version/Scream$Version.zip"

Write-Step "Downloading Scream $Version"
Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing

Write-Step 'Extracting'
Expand-Archive -Path $archive -DestinationPath $workDir -Force

# Located by search rather than by a hard-coded path: the archive layout has
# changed between releases, and a wrong guess would surface as a confusing
# "file not found" rather than as an unsupported-layout error.
$inf = Get-ChildItem -Path $workDir -Filter 'Scream.inf' -Recurse |
    Where-Object { $_.FullName -match 'x64' } |
    Select-Object -First 1
if (-not $inf) { $inf = Get-ChildItem -Path $workDir -Filter 'Scream.inf' -Recurse | Select-Object -First 1 }
if (-not $inf) { throw "Scream.inf not found under $workDir — the archive layout has changed." }

$catalogue = Join-Path $inf.DirectoryName 'Scream.cat'
if (-not (Test-Path $catalogue)) { throw "Scream.cat not found next to $($inf.FullName)." }

Write-Step 'Creating a throwaway driver-signing certificate'
$certificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject 'CN=Silverdaw CI Virtual Audio' `
    -KeyUsage DigitalSignature `
    -CertStoreLocation 'Cert:\LocalMachine\My' `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')

# Root makes the chain valid; TrustedPublisher stops Windows prompting for
# consent, which would hang an unattended install forever.
$exported = Join-Path $workDir 'signing.cer'
Export-Certificate -Cert $certificate -FilePath $exported | Out-Null
foreach ($store in 'Root', 'TrustedPublisher') {
    Import-Certificate -FilePath $exported -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null
}

$signtool = Get-ChildItem -Path 'C:\Program Files (x86)\Windows Kits\10\bin' -Filter 'signtool.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found — the Windows SDK is missing from this machine.' }

Write-Step 'Re-signing the driver catalogue'
& $signtool.FullName sign /v /fd SHA256 /sha1 $certificate.Thumbprint /s My $catalogue
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE." }

$devcon = Get-ChildItem -Path $workDir -Filter 'devcon*.exe' -Recurse |
    Where-Object { $_.Name -match 'x64|amd64' } |
    Select-Object -First 1
if (-not $devcon) { throw "devcon (x64) not found under $workDir." }

Write-Step 'Installing the driver'
& $devcon.FullName install $inf.FullName '*Scream'
if ($LASTEXITCODE -ne 0) { throw "devcon install failed with exit code $LASTEXITCODE." }

# The endpoint is published asynchronously once the audio service notices the
# new driver, so a bare check straight after install races it.
Write-Step 'Waiting for the endpoint to appear'
Restart-Service -Name 'audiosrv' -Force
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    if (Test-AudioEndpoint) { break }
    Start-Sleep -Seconds 2
}

if (-not (Test-AudioEndpoint)) {
    throw 'The virtual audio device installed but no healthy endpoint appeared.'
}

Write-Step 'Virtual audio device ready'
Get-PnpDevice -Class 'MEDIA' -Status 'OK' | Format-Table -AutoSize FriendlyName, Status
