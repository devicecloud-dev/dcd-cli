#!/usr/bin/env sh
# dcd installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://get.devicecloud.dev/install.sh | sh
#
# Env vars:
#   DCD_VERSION       Pin a specific version, e.g. for rollback (default: latest stable)
#   DCD_BETA          Set to any value to install the latest beta/prerelease (opt-in)
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

# Stable is the default channel and beta is strictly opt-in, so when no stable
# release exists yet (only prereleases published) we refuse to silently install a
# beta and instead point the user at the two explicit opt-ins. $DOWNLOAD_BASE is
# echoed so a custom host shows the right command.
no_stable_release_err() {
  printf 'error: No stable dcd release is available yet.\n' >&2
  printf '  Install the latest beta:  curl -fsSL %s/install.sh | DCD_BETA=1 sh\n' "$DOWNLOAD_BASE" >&2
  printf '  Or pin a version:         curl -fsSL %s/install.sh | DCD_VERSION=5.0.0-beta.1 sh\n' "$DOWNLOAD_BASE" >&2
  exit 1
}

# Find a dcd on PATH other than the one we just installed — usually a leftover
# `npm install -g @devicecloud.dev/dcd` that can shadow this binary. Runs in a
# subshell so the temporary IFS change never leaks back to the caller.
find_conflicting_dcd() {
  (
    IFS=:
    for dir in $PATH; do
      [ -n "$dir" ] || continue
      if [ "$dir" != "$INSTALL_DIR" ] && [ -x "$dir/dcd" ]; then
        printf '%s\n' "$dir/dcd"
        exit 0
      fi
    done
    exit 1
  )
}

# Pick the shell rc file to persist PATH into, based on the login shell.
rc_file() {
  case "${SHELL:-}" in
    *zsh)
      printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    *bash)
      if [ -f "$HOME/.bashrc" ]; then
        printf '%s\n' "$HOME/.bashrc"
      else
        printf '%s\n' "$HOME/.bash_profile"
      fi
      ;;
    *)
      printf '%s\n' "$HOME/.profile"
      ;;
  esac
}

# Persist INSTALL_DIR onto PATH in the given rc file, idempotently. Anything a
# previous run wrote is stripped first — the current sentinel-delimited block,
# and the legacy bare "# dcd" marker with its export line — so re-running the
# installer never accumulates duplicate markers or export lines. Trailing blank
# lines are trimmed so the rc doesn't grow a gap on each run. Returns non-zero
# (leaving the rc untouched) if it can't be written.
persist_path() {
  rc="$1"
  begin='# >>> dcd installer >>>'
  end='# <<< dcd installer <<<'

  if [ ! -e "$rc" ]; then
    : >> "$rc" 2>/dev/null || return 1
  fi
  [ -w "$rc" ] || return 1

  cleaned=$(mktemp "${TMPDIR:-/tmp}/dcd-rc-XXXXXX") || return 1
  # Drop our managed block (between the sentinels) and any legacy lines we may
  # have written before, then trim trailing blanks. buf[] preserves order.
  awk -v dir="$INSTALL_DIR" -v b="$begin" -v e="$end" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip    { next }
    $0 == "# dcd" { next }
    $0 == "export PATH=\"" dir ":$PATH\"" { next }
    { buf[++n] = $0 }
    END {
      while (n > 0 && buf[n] ~ /^[[:space:]]*$/) n--
      for (i = 1; i <= n; i++) print buf[i]
    }
  ' "$rc" > "$cleaned" || { rm -f "$cleaned"; return 1; }

  printf '\n%s\n%s\n%s\n' "$begin" "$path_line" "$end" >> "$cleaned" \
    || { rm -f "$cleaned"; return 1; }

  # Truncate-and-rewrite so the rc keeps its original inode and permissions.
  cat "$cleaned" > "$rc" || { rm -f "$cleaned"; return 1; }
  rm -f "$cleaned"
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
  # Precedence: explicit DCD_VERSION pin > DCD_BETA opt-in > latest stable.
  if [ -n "${DCD_VERSION:-}" ]; then
    version="$DCD_VERSION"
  else
    if [ -n "${DCD_BETA:-}" ]; then
      channel=beta
      manifest_url="$DOWNLOAD_BASE/latest.json?channel=beta"
      info "Resolving latest beta version..."
    else
      channel=stable
      manifest_url="$DOWNLOAD_BASE/latest.json"
      info "Resolving latest version..."
    fi

    # Fetch the manifest separately from parsing so we can tell a transient
    # network/proxy failure (curl -f returns non-zero → empty $manifest) apart
    # from a channel that simply has no release yet (HTTP 200 with
    # "version": null → $manifest non-empty but $version empty).
    manifest=$(curl -fsSL "$manifest_url") || manifest=""
    [ -z "$manifest" ] && err "Could not reach $manifest_url"
    # /latest.json returns { "version": "5.1.0", ... }; a null version is unquoted
    # and so won't match this quoted-string pattern.
    version=$(
      printf '%s' "$manifest" \
        | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n1
    )
    if [ -z "$version" ]; then
      if [ "$channel" = stable ]; then
        no_stable_release_err
      else
        err "No beta release is available yet from $manifest_url"
      fi
    fi
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

  # --- PATH setup ---
  path_line="export PATH=\"$INSTALL_DIR:\$PATH\""
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) on_path=1 ;;
    *)                  on_path=0 ;;
  esac

  info ""
  info "✓ Installed dcd $version to $INSTALL_DIR/dcd"

  if [ "$on_path" -eq 0 ]; then
    rc=$(rc_file)
    if persist_path "$rc"; then
      info ""
      info "  Added $INSTALL_DIR to your PATH in $rc."
      info "  Restart your shell, or run:  $path_line"
    else
      info ""
      info "  $INSTALL_DIR is not on your PATH. Add this to your shell rc:"
      info "    $path_line"
    fi
  fi

  # --- warn about a conflicting (shadowing) install ---
  if conflict=$(find_conflicting_dcd); then
    info ""
    info "! Another dcd is already on your PATH:"
    info "    $conflict"
    info "  This is usually a previous 'npm install -g @devicecloud.dev/dcd', which"
    info "  can shadow this binary depending on PATH order. Remove it with:"
    info "    npm uninstall -g @devicecloud.dev/dcd"
  fi

  if [ "$on_path" -eq 1 ]; then
    info ""
    info "  Try: dcd --help"
  fi
}

main "$@"
