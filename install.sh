#!/usr/bin/env bash
# ReCode installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/saali2901/recode/main/install.sh | bash
#
# What it does (nothing happens before you confirm, unless you pass -y):
#   1. makes sure git, curl and tar exist (installs them with your package manager if needed)
#   2. uses your Node.js (>= 20.11) or downloads an official, checksum-verified Node.js into the ReCode folder
#   3. downloads ReCode, builds it, and creates the "recode" command
#   4. runs "recode setup", which installs the remaining tools: JDK 21, C compiler, CMake, Ninja, Ghidra, Claude Code
#
# Options:  -y | --yes   do not ask          --dry-run   only show what would happen
#           --no-setup   skip step 4 (run "recode setup" later)
# Environment: RECODE_HOME_DIR (default ~/.local/share/recode)   RECODE_BIN_DIR (default ~/.local/bin)
#              RECODE_REPO, RECODE_REF (default: main)   RECODE_NODE_MAJOR (default 22)
#
# The whole script is wrapped in main() and only runs once it was downloaded completely.

main() {
  set -euo pipefail

  local YES=0 DRY=0 RUN_SETUP=1
  for arg in "$@"; do
    case "$arg" in
      -y | --yes) YES=1 ;;
      --dry-run) DRY=1 ;;
      --no-setup) RUN_SETUP=0 ;;
      -h | --help) sed -n '2,17p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; return 0 ;;
      *) echo "Unknown option: $arg" >&2; return 2 ;;
    esac
  done

  local DATA_DIR="${RECODE_HOME_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/recode}"
  local BIN_DIR="${RECODE_BIN_DIR:-$HOME/.local/bin}"
  local REPO="${RECODE_REPO:-https://github.com/saali2901/recode}"
  local REF="${RECODE_REF:-main}"
  local NODE_MAJOR="${RECODE_NODE_MAJOR:-22}"
  local APP_DIR="$DATA_DIR/app"
  local NODE_DIR="$DATA_DIR/node"

  say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
  warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
  die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
  run() { if [ "$DRY" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }

  local OS ARCH
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "Unsupported system: $(uname -s). On Windows use WSL2 (see README)." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
  esac

  # ask "question" -> 0 if yes. Reads from the terminal so it also works with "curl | bash".
  ask() {
    [ "$YES" = 1 ] && return 0
    if [ -r /dev/tty ] && [ -w /dev/tty ]; then
      local answer
      printf '%s [y/N] ' "$1" >/dev/tty
      read -r answer </dev/tty || answer=""
      case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
    fi
    die "No terminal available for confirmation. Re-run with -y to accept, or --dry-run to preview."
  }

  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    else shasum -a 256 "$1" | cut -d' ' -f1; fi
  }

  node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    local v major minor
    v="$(node -v | sed 's/^v//')"
    major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
    [ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 11 ]; }
  }

  say "ReCode installer ($OS/$ARCH)"
  echo "   install folder : $DATA_DIR"
  echo "   command        : $BIN_DIR/recode"
  echo "   source         : $REPO ($REF)"
  ask "Install ReCode now?" || { echo "Cancelled. Nothing was changed."; return 0; }

  # --- 1. git, curl, tar -------------------------------------------------------------------------
  local missing=()
  for tool in git curl tar; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    say "Installing missing basics: ${missing[*]}"
    local sudo_cmd=""
    [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo_cmd="sudo"
    if command -v apt-get >/dev/null 2>&1; then run $sudo_cmd apt-get update && run $sudo_cmd apt-get install -y "${missing[@]}"
    elif command -v dnf >/dev/null 2>&1; then run $sudo_cmd dnf install -y "${missing[@]}"
    elif command -v pacman >/dev/null 2>&1; then run $sudo_cmd pacman -S --needed --noconfirm "${missing[@]}"
    elif command -v brew >/dev/null 2>&1; then run brew install "${missing[@]}"
    else die "Please install ${missing[*]} and run this installer again."; fi
  fi

  run mkdir -p "$DATA_DIR" "$BIN_DIR"

  # --- 2. Node.js ---------------------------------------------------------------------------------
  local NODE_BIN="" PRIVATE_NODE=0
  if [ "${RECODE_FORCE_NODE_DOWNLOAD:-0}" != 1 ] && node_ok; then
    NODE_BIN="$(command -v node)"
    say "Using Node.js $(node -v) at $NODE_BIN"
  else
    say "Downloading Node.js ${NODE_MAJOR}.x (official build, checksum verified)"
    local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    local sums file expected tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    if [ "$DRY" = 1 ]; then
      echo "   [dry-run] would download $base/SHASUMS256.txt and node-v${NODE_MAJOR}.*-$OS-$ARCH.tar.gz"
    else
      curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "Cannot download $base/SHASUMS256.txt"
      sums="$(grep -E " node-v[0-9.]+-$OS-$ARCH\.tar\.gz\$" "$tmp/SHASUMS256.txt" | head -n1)"
      [ -n "$sums" ] || die "No Node.js build for $OS-$ARCH found."
      expected="${sums%% *}"; file="${sums##* }"
      curl -fSL --progress-bar "$base/$file" -o "$tmp/$file" || die "Node.js download failed."
      [ "$(sha256_of "$tmp/$file")" = "$expected" ] || die "Checksum mismatch for $file; aborting."
      rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
      tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
      NODE_BIN="$NODE_DIR/bin/node"
      PRIVATE_NODE=1
      say "Installed Node.js $("$NODE_BIN" -v) at $NODE_DIR"
    fi
  fi
  [ "$DRY" = 1 ] && [ -z "$NODE_BIN" ] && NODE_BIN="$NODE_DIR/bin/node" && PRIVATE_NODE=1
  local NODE_PATH_DIR
  NODE_PATH_DIR="$(dirname "$NODE_BIN")"
  export PATH="$NODE_PATH_DIR:$PATH"

  # --- 3. ReCode ----------------------------------------------------------------------------------
  say "Downloading ReCode"
  if [ -d "$APP_DIR/.git" ]; then
    run git -C "$APP_DIR" fetch --depth 1 origin "$REF"
    run git -C "$APP_DIR" checkout -q -f FETCH_HEAD
  else
    run rm -rf "$APP_DIR"
    run git clone --depth 1 --branch "$REF" "$REPO" "$APP_DIR"
  fi
  say "Building ReCode (this takes a minute)"
  if [ "$DRY" = 1 ]; then
    echo "   [dry-run] would run: npm ci && npm run build in $APP_DIR"
  else
    (cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build)
  fi

  say "Creating the recode command"
  if [ "$DRY" = 1 ]; then
    echo "   [dry-run] would write $BIN_DIR/recode"
  else
    {
      echo '#!/bin/sh'
      if [ "$PRIVATE_NODE" = 1 ]; then echo "export PATH=\"$NODE_PATH_DIR:\$PATH\""; fi
      echo "exec \"$NODE_BIN\" \"$APP_DIR/dist/index.js\" \"\$@\""
    } >"$BIN_DIR/recode"
    chmod +x "$BIN_DIR/recode"
  fi

  # --- 4. remaining tools -------------------------------------------------------------------------
  if [ "$RUN_SETUP" = 1 ]; then
    say "Installing the remaining tools (JDK, compiler, CMake, Ninja, Ghidra, Claude Code)"
    local setup_args=(setup)
    [ "$YES" = 1 ] && setup_args+=(--yes)
    [ "$DRY" = 1 ] && setup_args+=(--dry-run)
    if [ "$DRY" = 1 ] && [ ! -x "$BIN_DIR/recode" ]; then
      echo "   [dry-run] would run: recode setup"
    else
      "$BIN_DIR/recode" "${setup_args[@]}"
    fi
  fi

  say "Done."
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      warn "$BIN_DIR is not in your PATH. Add this line to ~/.bashrc or ~/.zshrc, then open a new terminal:"
      echo "    export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
  cat <<MSG

Next steps:
  recode doctor          # shows what is installed
  claude                 # once: log in with your Claude subscription
  recode ui --open       # start the web interface   (or: recode init demo && cd demo && recode import <file> && recode run)
MSG
}

main "$@"
