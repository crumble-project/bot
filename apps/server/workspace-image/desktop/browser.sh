#!/bin/bash
# Keeps Chromium running; the job cannot rely on the panel to relaunch it.
. /run/crumble-desktop.env
mkdir -p /workspace/.desktop/chromium
# Chromium trusts an added authority only from its NSS database; the host installs the bot's at every boot.
ca=/usr/local/share/ca-certificates/crumble-credentials.crt
nssdb="sql:${HOME:-/root}/.pki/nssdb"
if [ -f "$ca" ]; then
  mkdir -p "${HOME:-/root}/.pki/nssdb"
  certutil -d "$nssdb" -L >/dev/null 2>&1 || certutil -d "$nssdb" -N --empty-password
  certutil -d "$nssdb" -A -t "C,," -n crumble-credentials -i "$ca"
fi
# A profile restored onto another machine (a Railway checkpoint) keeps the old host's lock, and Chromium then refuses it.
rm -f /workspace/.desktop/chromium/Singleton{Lock,Socket,Cookie}
while true; do
  # --no-sandbox: the guest runs as root, and the VM is the sandbox.
  # --hide-crash-restore-bubble: stopping the VM kills Chromium, which would offer to restore pages on every boot.
  chromium --no-sandbox --test-type --no-first-run --disable-gpu --force-renderer-accessibility --hide-crash-restore-bubble \
    --user-data-dir=/workspace/.desktop/chromium --start-maximized about:blank
  sleep 1
done
