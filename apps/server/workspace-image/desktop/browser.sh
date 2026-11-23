#!/bin/bash
. /run/crumble-desktop.env
mkdir -p /workspace/.desktop/chromium
ca=/usr/local/share/ca-certificates/crumble-credentials.crt
nssdb="sql:${HOME:-/root}/.pki/nssdb"
if [ -f "$ca" ]; then
  mkdir -p "${HOME:-/root}/.pki/nssdb"
  certutil -d "$nssdb" -L >/dev/null 2>&1 || certutil -d "$nssdb" -N --empty-password
  certutil -d "$nssdb" -A -t "C,," -n crumble-credentials -i "$ca"
fi
rm -f /workspace/.desktop/chromium/Singleton{Lock,Socket,Cookie}
while true; do
  chromium --no-sandbox --test-type --no-first-run --disable-gpu --force-renderer-accessibility --hide-crash-restore-bubble \
    --password-store=basic \
    --user-data-dir=/workspace/.desktop/chromium --start-maximized about:blank
  sleep 1
done
