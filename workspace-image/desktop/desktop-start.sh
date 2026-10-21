#!/bin/bash
# Starts the bot desktop once per boot; a second run while it is up only waits for it.
# The host runs this at boot, outside pi-env, whose daemon kills every process it started when it stops.
set -u
export DISPLAY=:1
if ! pgrep -x Xvnc >/dev/null; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  # Localhost only: the viewer (milestone 2) reaches it through the host.
  nohup Xvnc :1 -geometry 1280x800 -depth 24 -SecurityTypes None -localhost yes -rfbport 5900 -AlwaysShared >/tmp/xvnc.log 2>&1 &
  for _ in $(seq 50); do [ -S /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
  eval "$(dbus-launch --sh-syntax)"
  {
    echo "export DISPLAY=:1 CUA_DRIVER_RS_TELEMETRY_ENABLED=0 DO_NOT_TRACK=1"
    echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'"
  } > /run/crumble-desktop.env
  nohup /usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi.log 2>&1 &
  # Chromium reads the accessibility switch only at startup; turn it on before the browser starts.
  for _ in $(seq 50); do
    dbus-send --session --dest=org.a11y.Bus /org/a11y/bus org.freedesktop.DBus.Properties.Set \
      string:org.a11y.Status string:IsEnabled variant:boolean:true 2>/dev/null && break
    sleep 0.1
  done
  nohup cua-driver serve --grant existing-profile >/tmp/cua-driver.log 2>&1 &
  nohup openbox --config-file /opt/crumble/openbox-rc.xml >/tmp/openbox.log 2>&1 &
  sleep 0.5
  nohup tint2 >/tmp/tint2.log 2>&1 &
  nohup /opt/crumble/browser.sh >/tmp/browser.log 2>&1 &
fi
. /run/crumble-desktop.env
for _ in $(seq 150); do
  cua-driver call list_windows '{}' 2>/dev/null | grep -q '"app_name": "Chromium"' && exit 0
  sleep 0.2
done
echo "bot desktop did not start; see /tmp/*.log" >&2
exit 1
