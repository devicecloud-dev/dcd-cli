# dcd installer for Windows.
#
# Usage:
#   irm https://get.devicecloud.dev/install.ps1 | iex
#
# Env vars:
#   DCD_VERSION       Pin a specific version, e.g. for rollback (default: latest stable)
#   DCD_BETA          Set to any value to install the latest beta/prerelease (opt-in)
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
# Precedence: explicit DCD_VERSION pin > DCD_BETA opt-in > latest stable.
if ($env:DCD_VERSION) {
    $version = $env:DCD_VERSION
} else {
    if ($env:DCD_BETA) {
        Write-Host 'Resolving latest beta version...'
        $manifestUrl = "$DownloadBase/latest.json?channel=beta"
        $channel = 'beta'
    } else {
        Write-Host 'Resolving latest version...'
        $manifestUrl = "$DownloadBase/latest.json"
        $channel = 'stable'
    }
    try {
        $manifest = Invoke-RestMethod -Uri $manifestUrl
    } catch {
        throw "Could not reach $manifestUrl"
    }
    # A null version means the channel has no release yet (HTTP 200), as opposed
    # to a transient failure (which throws above). Stable is the default and beta
    # is strictly opt-in, so refuse to silently fall back to a prerelease.
    $version = $manifest.version
    if (-not $version) {
        if ($channel -eq 'stable') {
            throw @"
No stable dcd release is available yet.
  Install the latest beta:  `$env:DCD_BETA=1; irm '$DownloadBase/install.ps1' | iex
  Or pin a version:         `$env:DCD_VERSION='5.0.0-beta.1'; irm '$DownloadBase/install.ps1' | iex
"@
        } else {
            throw "No beta release is available yet from $manifestUrl"
        }
    }
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
    # GitHub serves SHA256SUMS as application/octet-stream, so under
    # -UseBasicParsing on Windows PowerShell 5.x .Content comes back as a
    # Byte[] (not a string) and -split would never match. Decode to UTF-8 text.
    $sumsResp = Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing
    $sums = if ($sumsResp.Content -is [byte[]]) {
        [System.Text.Encoding]::UTF8.GetString($sumsResp.Content)
    } else {
        [string]$sumsResp.Content
    }
    $expected = ($sums -split "`n" |
        Where-Object { $_ -match "^([a-f0-9]{64})\s+$([regex]::Escape($asset))\s*$" } |
        ForEach-Object { $matches[1] } |
        Select-Object -First 1)
    if (-not $expected) { throw "SHA256SUMS has no entry for $asset" }
    $actual = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
        throw "Checksum mismatch for ${asset}: expected $expected, got $actual"
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
