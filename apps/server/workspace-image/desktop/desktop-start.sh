#!/bin/bash
# Starts the bot desktop once per boot; a second run while it is up only waits for it.
# With --display it returns once the VNC server listens, before the browser is up.
# The host runs this at boot, outside pi-env, whose daemon kills every process it started when it stops.
set -u
export DISPLAY=:1 HOME="${HOME:-/root}"
here=/opt/crumble
if ! pgrep -x Xvnc >/dev/null; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  # Localhost only: the viewer (milestone 2) reaches it through the host. -s 0: no screen blanking.
  nohup Xvnc :1 -geometry 1280x800 -depth 24 -SecurityTypes None -localhost yes -rfbport 5900 -AlwaysShared -s 0 \
    >/tmp/xvnc.log 2>&1 &
  # Reset on every boot, so settings a job changed last time don't carry over.
  conf="$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
  mkdir -p "$conf" "$HOME/.config/gtk-3.0" /usr/local/share/applications /etc/chromium/policies/managed
  cp "$here/xfwm4.xml" "$here/xfce4-panel.xml" "$here/xfce4-desktop.xml" "$conf/"
  cp "$here/chromium.desktop" "$here/crumble-files.desktop" "$here/crumble-terminal.desktop" /usr/local/share/applications/
  echo "file:///workspace Workspace" > "$HOME/.config/gtk-3.0/bookmarks"
  cp "$here/thunar-gtk.css" "$HOME/.config/gtk-3.0/gtk.css"
  # Chromium would offer to save the logins desktop jobs fill into its profile on /workspace, where coding jobs can read it.
  cp "$here/chromium-policy.json" /etc/chromium/policies/managed/crumble.json
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
  # Apps started from the panel open in the workspace.
  cd /workspace || exit 1
  # No xfce4-session: it would save and restore sessions and run its autostart entries.
  nohup xfwm4 >/tmp/xfwm4.log 2>&1 &
  nohup "$here/maximize.sh" >/tmp/maximize.log 2>&1 &
  # Draws the wallpaper; desktop icons are off in its configuration.
  nohup xfdesktop >/tmp/xfdesktop.log 2>&1 &
  sleep 0.5
  # Skips the panel's first-run dialog should its configuration ever be missing.
  XFCE_PANEL_MIGRATE_DEFAULT=1 nohup xfce4-panel >/tmp/xfce4-panel.log 2>&1 &
  nohup "$here/browser.sh" >/tmp/browser.log 2>&1 &
fi
if [ "${1:-}" = --display ]; then
  for _ in $(seq 50); do (: </dev/tcp/127.0.0.1/5900) 2>/dev/null && exit 0; sleep 0.1; done
  echo "the VNC server did not start; see /tmp/xvnc.log" >&2
  exit 1
fi
. /run/crumble-desktop.env
# Debian's Chromium reports "Chromium", the snapshot build on Railway "Chromium-browser".
for _ in $(seq 150); do
  cua-driver call list_windows '{}' 2>/dev/null | grep -q '"app_name": "Chromium' && exit 0
  sleep 0.2
done
echo "bot desktop did not start; see /tmp/*.log" >&2
exit 1
