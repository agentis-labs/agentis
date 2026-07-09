#!/usr/bin/env sh
# Agentis installer — POSIX shells (macOS, Linux, WSL).
#
# Usage:
#   curl -fsSL https://get.agentis.dev/install.sh | sh
#
# What it does:
#   1. Verifies Node ≥ 20.10 is on PATH (offers a hint if not).
#   2. Runs `npx @agentis-labs/cli@latest up`, which generates secrets, initialises
#      SQLite, seeds the operator user, and starts the server on :3737.

set -eu

REQUIRED_MAJOR=20
REQUIRED_MINOR=10

err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  err "Node.js is required but was not found on PATH."
  err "Install Node ≥ ${REQUIRED_MAJOR}.${REQUIRED_MINOR} from https://nodejs.org/ and re-run this script."
  exit 1
fi

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f1)"
NODE_MINOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f2)"

if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ] \
   || { [ "$NODE_MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$NODE_MINOR" -lt "$REQUIRED_MINOR" ]; }; then
  err "Node ${NODE_VERSION} is too old. Agentis requires ≥ ${REQUIRED_MAJOR}.${REQUIRED_MINOR}."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  err "npx is required (it ships with npm). Reinstall Node from https://nodejs.org/."
  exit 1
fi

info "Node ${NODE_VERSION} detected. Starting Agentis…"
exec npx --yes @agentis-labs/cli@latest up "$@"
