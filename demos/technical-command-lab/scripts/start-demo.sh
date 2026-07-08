#!/usr/bin/env sh
set -eu

DATA_DIR="${AGENTIS_DATA_DIR:-.agentis-demo}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
AGENTIS_DATA_DIR="$DATA_DIR" pnpm dev:full

