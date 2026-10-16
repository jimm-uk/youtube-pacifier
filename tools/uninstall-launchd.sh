#!/bin/sh
# Remove the scheduled fetch and the portal server.
for job in fetch serve; do
  label="local.pacifier.$job"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  echo "removed $label"
done
