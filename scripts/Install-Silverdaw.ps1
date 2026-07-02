<#
.SYNOPSIS
    Installs Silverdaw from the downloaded release files: trusts the self-signed
    publisher certificate, then installs the signed MSIX/AppX package.

.DESCRIPTION
    Silverdaw's sideload package is signed with a self-signed "CN=Silverdaw"
    certificate. Windows will not install a self-signed MSIX until that
    certificate is trusted, so this script:
      1. Verifies the certificate file's SHA-256 fingerprint (a tamper check).
      2. Imports the PUBLIC certificate into the machine's "Trusted People" store.
      3. Installs the Silverdaw .appx package with Add-AppxPackage.

    The .cer is the PUBLIC half of the certificate only (no private key). It
    simply tells this machine to trust app packages signed by "CN=Silverdaw" —
    it cannot be used to sign anything. You can remove it again at any time
    (see UNINSTALL below).

.NOTES
    ============================  HOW TO USE  ============================
    1. Download these files from the release into the SAME folder:
         - Install-Silverdaw.ps1        (this script)
         - Silverdaw-<version>.appx     (the signed app package)
         - Silverdaw-PublicCert.cer     (the public certificate)

    2. Right-click "Install-Silverdaw.ps1" > "Run with PowerShell".
       (If Windows blocks it, first: right-click the file > Properties >
        tick "Unblock" > OK. Or run from an elevated PowerShell:
          powershell -ExecutionPolicy Bypass -File .\Install-Silverdaw.ps1 )

    3. Approve the User Account Control (UAC) prompt. Administrator rights are
       needed ONLY to add the certificate to the machine's trust store.

    Prefer not to trust a certificate at all? Two other options ship in the
    same release:
      - Install from the Microsoft Store (Microsoft signs it; no cert needed).
      - Use the portable Silverdaw-<version>.zip (unzip and run Silverdaw.exe;
        no install and no certificate required).

    ============================  UNINSTALL  ============================
      # Remove the app:
      Get-AppxPackage *Silverdaw* | Remove-AppxPackage

      # Remove the trusted certificate (run elevated):
      Get-ChildItem Cert:\LocalMachine\TrustedPeople |
        Where-Object { $_.Subject -eq 'CN=Silverdaw' } | Remove-Item
    =====================================================================
#>
[CmdletBinding()]
param(
    # Signed package to install. Defaults to the newest Silverdaw-*.appx next to
    # this script (the unsigned "-store" package is excluded — that one is only
    # for Microsoft Store submission and cannot be installed locally).
    [string]$Package,

    # Public certificate to trust. Defaults to Silverdaw-PublicCert.cer next to
    # this script.
    [string]$Certificate,

    # Expected SHA-256 fingerprint of the .cer, published with this release.
    # The script refuses to trust a certificate whose fingerprint differs. Pass
    # -ExpectedCertSha256 '' to skip the check (not recommended).
    [string]$ExpectedCertSha256 = 'C7D9C86FA13C579AF3F1636ECD70F5D53B904187AAD13439A69301BEC65C8F1B'
)

$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The Appx / PKI cmdlets are most reliable under Windows PowerShell, and trusting
# the certificate requires elevation, so relaunch into an elevated Windows
# PowerShell if we are not already both. Supplied paths are forwarded as ABSOLUTE
# because the relaunched process starts in a different working directory.
$isAdmin = Test-IsAdministrator
$isWindowsPowerShell = $PSVersionTable.PSEdition -eq 'Desktop'
if (-not ($isAdmin -and $isWindowsPowerShell)) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Package) {
        $p = (Resolve-Path -LiteralPath $Package -ErrorAction SilentlyContinue).Path
        if (-not $p) { $p = $Package }
        $argList += @('-Package', "`"$p`"")
    }
    if ($Certificate) {
        $c = (Resolve-Path -LiteralPath $Certificate -ErrorAction SilentlyContinue).Path
        if (-not $c) { $c = $Certificate }
        $argList += @('-Certificate', "`"$c`"")
    }
    if ($PSBoundParameters.ContainsKey('ExpectedCertSha256')) {
        $argList += @('-ExpectedCertSha256', "`"$ExpectedCertSha256`"")
    }
    $startArgs = @{ FilePath = 'powershell.exe'; ArgumentList = $argList }
    if (-not $isAdmin) { $startArgs['Verb'] = 'RunAs' }
    $msg = if ($isAdmin) { 'Relaunching under Windows PowerShell...' }
           else { 'Requesting administrator rights (needed to trust the certificate)...' }
    Write-Host $msg -ForegroundColor Cyan
    try {
        Start-Process @startArgs
    } catch {
        Write-Host 'Could not relaunch (elevation may have been declined); cannot continue.' -ForegroundColor Red
    }
    return
}

$certImported = $false
$exitCode = 0
try {
    # Resolve defaults relative to this script (download all files to one folder).
    if (-not $Certificate) {
        $Certificate = Join-Path $PSScriptRoot 'Silverdaw-PublicCert.cer'
    }
    if (-not $Package) {
        $Package = Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'Silverdaw-*.appx' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike '*-store.appx' } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }

    if (-not (Test-Path -LiteralPath $Certificate)) {
        throw "Certificate not found: '$Certificate'. Put Silverdaw-PublicCert.cer next to this script, or pass -Certificate <path>."
    }
    if (-not $Package -or -not (Test-Path -LiteralPath $Package)) {
        throw "Signed package (Silverdaw-<version>.appx) not found next to this script. Pass -Package <path> to specify it."
    }
    if ((Split-Path -Leaf $Package) -like '*-store.appx') {
        throw "'$(Split-Path -Leaf $Package)' is the unsigned Microsoft Store package and cannot be installed locally. Use Silverdaw-<version>.appx instead."
    }

    # 1. Tamper check: the downloaded .cer must match the published fingerprint.
    #    This authenticates the trust anchor (certificate); the .appx itself is
    #    then verified by Windows against this certificate's signature at install.
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCertSha256)) {
        $actual = (Get-FileHash -LiteralPath $Certificate -Algorithm SHA256).Hash
        if ($actual -ne $ExpectedCertSha256.Trim().ToUpperInvariant()) {
            throw ("Certificate fingerprint MISMATCH — do NOT trust this file.`n" +
                   "  expected: $ExpectedCertSha256`n" +
                   "  actual  : $actual`n" +
                   "Re-download Silverdaw-PublicCert.cer from the official release.")
        }
        Write-Host "Certificate fingerprint verified (SHA-256 matches the release)." -ForegroundColor Green
    }

    # 2. Trust the publisher. TrustedPeople is the narrow store MSIX deployment
    #    consults — narrower than Trusted Root and all Add-AppxPackage needs.
    Write-Host "Trusting publisher certificate (CN=Silverdaw)..." -ForegroundColor Cyan
    Import-Certificate -FilePath $Certificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
    $certImported = $true

    # 3. Install the signed package.
    Write-Host "Installing $(Split-Path -Leaf $Package)..." -ForegroundColor Cyan
    Add-AppxPackage -Path $Package

    Write-Host ''
    Write-Host 'Silverdaw installed successfully. Launch it from the Start menu.' -ForegroundColor Green
}
catch {
    $exitCode = 1
    Write-Host ''
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($certImported) {
        Write-Host 'The Silverdaw certificate was trusted before the failure. To remove it (run elevated):' -ForegroundColor Yellow
        Write-Host "  Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object { `$_.Subject -eq 'CN=Silverdaw' } | Remove-Item" -ForegroundColor Yellow
    }
    Write-Host 'If a version is already installed or a dependency is missing, remove any existing copy and retry:' -ForegroundColor Yellow
    Write-Host '  Get-AppxPackage *Silverdaw* | Remove-AppxPackage' -ForegroundColor Yellow
}
finally {
    # Keep the window open so the result is visible when run via right-click / UAC.
    # Guarded so unattended (-NonInteractive) runs don't fail on Read-Host.
    if ($Host.Name -eq 'ConsoleHost') {
        try { Read-Host 'Press Enter to close' | Out-Null } catch {}
    }
}

exit $exitCode
