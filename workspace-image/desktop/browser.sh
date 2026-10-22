#!/bin/bash
# Keeps Chromium running; the job cannot rely on the panel to relaunch it.
. /run/crumble-desktop.env
mkdir -p /workspace/.desktop/chromium
while true; do
  # --no-sandbox: the guest runs as root, and the VM is the sandbox.
  # --hide-crash-restore-bubble: stopping the VM kills Chromium, which would offer to restore pages on every boot.
  chromium --no-sandbox --test-type --no-first-run --disable-gpu --force-renderer-accessibility --hide-crash-restore-bubble \
    --user-data-dir=/workspace/.desktop/chromium --start-maximized about:blank
  sleep 1
done
