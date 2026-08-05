#!/usr/bin/env bash
# macOS: keep bot online while display may blank.
# Use -dims: also assert PreventUserIdleDisplaySleep so Wi‑Fi is less likely
# to drop when the panel would otherwise sleep (common on Apple Silicon).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CONFIG="${1:-config.json}"

echo "[start-mac] caffeinate -dims (system + idle + disk + display); config=$CONFIG"
exec caffeinate -dims npm start -- --config "$CONFIG"
