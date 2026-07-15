#!/usr/bin/env bash
set -euo pipefail

# Build the VSIX extension package for opencode-zen-chat-provider.
# Prerequisites: Node.js, npm, and VSCE available via npx.

cd "$(dirname "$0")/../.."

echo "=== Ensuring release manifest is unmarked (no DEBUG prefix) ==="
node ./scripts/dev-marker.js unmark

echo "=== Installing dependencies ==="
npm install

echo "=== Compiling TypeScript ==="
npm run compile

echo "=== Packaging VSIX ==="
npx --registry https://registry.npmjs.org @vscode/vsce package \
  --allow-missing-repository

echo "=== Done ==="
ls -lh ./*.vsix
