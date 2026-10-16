#!/bin/sh
# Install (or reinstall) the daily 07:00 fetch and the always-on portal server.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$(command -v python3)"
"$PYTHON" -c 'import tomllib' 2>/dev/null || { echo "need Python 3.11+ (found $PYTHON)"; exit 1; }
DEST="$HOME/Library/LaunchAgents"
mkdir -p "$DEST" "$ROOT/data/logs"
for job in fetch serve; do
  label="local.pacifier.$job"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  sed -e "s#__ROOT__#$ROOT#g" -e "s#__PYTHON__#$PYTHON#g" \
    "$ROOT/launchd/$label.plist" > "$DEST/$label.plist"
  launchctl bootstrap "gui/$(id -u)" "$DEST/$label.plist"
  echo "installed $label"
done
echo "Portal: http://127.0.0.1:8765"
