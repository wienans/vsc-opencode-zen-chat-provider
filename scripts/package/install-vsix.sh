#!/usr/bin/env bash
set -euo pipefail

# Install a VSIX extension into VS Code.
# Usage: ./scripts/package/install-vsix.sh [<vsix-file>]
# If no file is specified, the latest .vsix in project root is used.

cd "$(dirname "$0")/../.."

VSIX_FILE="${1:-}"

if [ -z "$VSIX_FILE" ]; then
  VSIX_FILE=$(ls -t ./*.vsix 2>/dev/null | head -1 || true)
  if [ -z "$VSIX_FILE" ]; then
    echo "Error: No .vsix file found in project root."
    echo "Usage: $0 [<path-to-vsix>]"
    exit 1
  fi
  echo "Using latest VSIX: $VSIX_FILE"
fi

if [ ! -f "$VSIX_FILE" ]; then
  echo "Error: File not found: $VSIX_FILE"
  exit 1
fi

echo "=== Installing extension: $VSIX_FILE ==="
code --install-extension "$VSIX_FILE"

echo "=== Done ==="
