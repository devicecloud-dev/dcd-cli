#!/usr/bin/env sh
# dcd installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://get.devicecloud.dev/install.sh | sh
#
# Env vars:
#   DCD_VERSION       Pin a specific version (default: latest)
#   DCD_INSTALL_DIR   Override install location (default: $HOME/.dcd/bin)
#   DCD_DOWNLOAD_BASE Override the download host (default: https://get.devicecloud.dev)
#
# The whole script is wrapped in main() and only invoked on the last line, so
# a truncated download (curl | sh executes as it streams) runs nothing at all.

set -eu

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1"
}

main() {
  DOWNLOAD_BASE="${DCD_DOWNLOAD_BASE:-https://get.devicecloud.dev}"
  INSTALL_DIR="${DCD_INSTALL_DIR:-$HOME/.dcd/bin}"

  # --- detect platform ---
  os=$(uname -s)
  case "$os" in
    Darwin) os_id=darwin ;;
    Linux)  os_id=linux ;;
    *)      err "Unsupported OS: $os. Try the Windows installer (install.ps1)." ;;
  esac

  arch=$(uname -m)
  case "$arch" in
    arm64|aarch64) arch_id=arm64 ;;
    x86_64|amd64)  arch_id=x64 ;;
    *)             err "Unsupported architecture: $arch" ;;
  esac

  asset="dcd-${os_id}-${arch_id}"

  # --- resolve version ---
  if [ -n "${DCD_VERSION:-}" ]; then
    version="$DCD_VERSION"
  else
    info "Resolving latest version..."
    # /latest.json returns { "version": "5.1.0", ... }
    version=$(
      curl -fsSL "$DOWNLOAD_BASE/latest.json" \
        | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n1
    )
    [ -z "$version" ] && err "Could not resolve latest version from $DOWNLOAD_BASE/latest.json"
  fi

  url="$DOWNLOAD_BASE/download/${version}/${asset}"
  sums_url="$DOWNLOAD_BASE/download/${version}/SHA256SUMS"

  info "Installing dcd ${version} (${os_id}-${arch_id})"
  info "  from: $url"
  info "  to:   $INSTALL_DIR/dcd"

  # --- download ---
  mkdir -p "$INSTALL_DIR"
  tmp=$(mktemp "${TMPDIR:-/tmp}/dcd-XXXXXX")
  trap 'rm -f "$tmp" "$tmp.sums"' EXIT
  curl -fSL --progress-bar "$url" -o "$tmp" \
    || err "Download failed: $url"

  # --- verify checksum ---
  curl -fsSL "$sums_url" -o "$tmp.sums" \
    || err "Could not fetch checksums: $sums_url"
  expected=$(grep -F "  ${asset}" "$tmp.sums" | awk '{print $1}' | head -n1)
  [ -z "$expected" ] && err "SHA256SUMS has no entry for $asset"

  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
  else
    err "Need sha256sum or shasum to verify download"
  fi

  if [ "$expected" != "$actual" ]; then
    err "Checksum mismatch for $asset: expected $expected, got $actual"
  fi

  # --- install ---
  chmod +x "$tmp"
  mv "$tmp" "$INSTALL_DIR/dcd"
  trap - EXIT  # tmp has been moved; nothing to clean up

  # --- PATH hint ---
  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      info ""
      info "✓ Installed: $($INSTALL_DIR/dcd --version 2>/dev/null || echo "$version")"
      info "  Try: dcd --help"
      ;;
    *)
      info ""
      info "✓ Installed dcd $version to $INSTALL_DIR/dcd"
      info ""
      info "  $INSTALL_DIR is not on your PATH. Add this to your shell rc:"
      info "    export PATH=\"$INSTALL_DIR:\$PATH\""
      info ""
      info "  Then restart your shell, or run:"
      info "    export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac
}

main "$@"
