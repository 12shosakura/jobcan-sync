#!/bin/bash
# Register the sync app as a macOS LaunchAgent so it starts at login and
# restarts if it ever crashes.
set -euo pipefail

LABEL="com.jobcan.gcal-sync"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_DIR="${JOBCAN_SYNC_DATA_DIR:-$HOME/.jobcan-gcal-sync}"
PORT="${JOBCAN_SYNC_PORT:-5675}"

[ -n "$NODE_BIN" ] || { echo "node not found on PATH" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$DATA_DIR"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JOBCAN_SYNC_PORT</key><string>$PORT</string>
    <key>JOBCAN_SYNC_DATA_DIR</key><string>$DATA_DIR</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/service.out.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/service.err.log</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "Installed $LABEL"
echo "Open http://127.0.0.1:$PORT"
