#!/bin/bash
# Remove the LaunchAgent. Credentials in the data directory are left alone.
set -euo pipefail

LABEL="com.jobcan.gcal-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL. Credentials remain in ${JOBCAN_SYNC_DATA_DIR:-$HOME/.jobcan-gcal-sync}"
