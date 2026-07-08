#!/usr/bin/env sh
set -eu

DATA_DIR="${AGENTIS_DATA_DIR:-.agentis-demo}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TARGET="$ROOT/$DATA_DIR"

case "$TARGET" in
  "$ROOT"/*) ;;
  *) echo "Refusing to remove a path outside the repository: $TARGET" >&2; exit 1 ;;
esac

if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  echo "Removed $TARGET"
else
  echo "No demo data dir found at $TARGET"
fi

