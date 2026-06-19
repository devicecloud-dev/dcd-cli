# dcd installer for Windows.
#
# Usage:
#   irm https://get.devicecloud.dev/install.ps1 | iex
#
# Env vars:
#   DCD_VERSION       Pin a specific version (default: latest)
#   DCD_INSTALL_DIR   Override install location (default: $env:USERPROFILE\.dcd\bin)
#   DCD_DOWNLOAD_BASE Override the download host (default: https://get.devicecloud.dev)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.x defaults to TLS 1.0/1.1, which modern hosts reject.
# PowerShell 6+ negotiates TLS correctly on its own, so only patch 5.x.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$DownloadBase = if ($env:DCD_DOWNLOAD_BASE) { $env:DCD_DOWNLOAD_BASE } else { 'https://get.devicecloud.dev' }
$InstallDir   = if ($env:DCD_INSTALL_DIR)   { $env:DCD_INSTALL_DIR }   else { Join-Path $env:USERPROFILE '.dcd\bin' }

if ([Environment]::Is64BitOperatingSystem -ne $true) {
    throw 'Only 64-bit Windows is supported.'
}
$asset = 'dcd-windows-x64.exe'

# --- resolve version ---
if ($env:DCD_VERSION) {
    $version = $env:DCD_VERSION
} else {
    Write-Host 'Resolving latest version...'
    $manifest = Invoke-RestMethod -Uri "$DownloadBase/latest.json"
    $version = $manifest.version
    if (-not $version) { throw "Could not resolve latest version from $DownloadBase/latest.json" }
}

$url     = "$DownloadBase/download/$version/$asset"
$sumsUrl = "$DownloadBase/download/$version/SHA256SUMS"

Write-Host "Installing dcd $version (windows-x64)"
Write-Host "  from: $url"
Write-Host "  to:   $InstallDir\dcd.exe"

# --- download ---
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName() + '.exe')
try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

    # --- verify checksum ---
    $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
    $expected = ($sums -split "`n" |
        Where-Object { $_ -match "^([a-f0-9]{64})\s+$([regex]::Escape($asset))\s*$" } |
        ForEach-Object { $matches[1] } |
        Select-Object -First 1)
    if (-not $expected) { throw "SHA256SUMS has no entry for $asset" }
    $actual = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
        throw "Checksum mismatch for $asset: expected $expected, got $actual"
    }

    # --- install ---
    $target = Join-Path $InstallDir 'dcd.exe'
    Move-Item -Path $tmp -Destination $target -Force
} catch {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    throw
}

# --- PATH update (user scope) ---
# Read the raw, unexpanded registry value (REG_EXPAND_SZ entries such as
# %USERPROFILE% must survive the round-trip; [Environment]::GetEnvironmentVariable
# would expand and freeze them). Append the install dir rather than rewriting
# the whole value, and skip entirely if it is already present.
$regKey = Get-Item -Path 'HKCU:\Environment'
$rawPath = [string]$regKey.GetValue(
    'Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
)
$normalizedDir = $InstallDir.TrimEnd('\')
$alreadyOnPath = @(
    ($rawPath -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $normalizedDir) }
).Count -gt 0
if (-not $alreadyOnPath) {
    $newPath = if ($rawPath -eq '') { $InstallDir } else { $rawPath.TrimEnd(';') + ';' + $InstallDir }
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $newPath -Type ExpandString
    Write-Host ''
    Write-Host "Installed dcd $version to $InstallDir\dcd.exe"
    Write-Host "Added $InstallDir to your user PATH. Open a new terminal to pick it up."
} else {
    Write-Host ''
    Write-Host "Installed: $(& "$InstallDir\dcd.exe" --version)"
    Write-Host '  Try: dcd --help'
}

# --- warn about a conflicting (shadowing) install ---
# A leftover `npm install -g @devicecloud.dev/dcd` resolves earlier on PATH than
# the appended install dir, so it would keep shadowing this binary. Get-Command
# reads the current session PATH (which doesn't include the registry change we
# just made), so any hit here is a different, pre-existing dcd.
$target = Join-Path $InstallDir 'dcd.exe'
$existing = Get-Command dcd -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -and ($_.Source -ine $target) } |
    Select-Object -First 1
if ($existing) {
    Write-Host ''
    Write-Host '! Another dcd is already on your PATH:'
    Write-Host "    $($existing.Source)"
    Write-Host "  This is usually a previous 'npm install -g @devicecloud.dev/dcd', which"
    Write-Host '  can shadow this binary depending on PATH order. Remove it with:'
    Write-Host '    npm uninstall -g @devicecloud.dev/dcd'
}
