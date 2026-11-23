#!/bin/bash
set -u
export DISPLAY=:1 HOME="${HOME:-/root}"
here=/opt/crumble
if ! pgrep -x Xvnc >/dev/null; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  nohup Xvnc :1 -geometry 1280x800 -depth 24 -SecurityTypes None -localhost yes -rfbport 5900 -AlwaysShared -s 0 \
    >/tmp/xvnc.log 2>&1 &
  conf="$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
  mkdir -p "$conf" "$HOME/.config/gtk-3.0" /usr/local/share/applications /etc/chromium/policies/managed
  cp "$here/xfwm4.xml" "$here/xfce4-panel.xml" "$here/xfce4-desktop.xml" "$conf/"
  cp "$here/chromium.desktop" "$here/crumble-files.desktop" "$here/crumble-terminal.desktop" /usr/local/share/applications/
  echo "file:///workspace Workspace" > "$HOME/.config/gtk-3.0/bookmarks"
  cp "$here/thunar-gtk.css" "$HOME/.config/gtk-3.0/gtk.css"
  cp "$here/chromium-policy.json" /etc/chromium/policies/managed/crumble.json
  for _ in $(seq 50); do [ -S /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
  eval "$(dbus-launch --sh-syntax)"
  {
    echo "export DISPLAY=:1 CUA_DRIVER_RS_TELEMETRY_ENABLED=0 DO_NOT_TRACK=1"
    echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'"
  } > /run/crumble-desktop.env
  nohup /usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi.log 2>&1 &
  for _ in $(seq 50); do
    dbus-send --session --dest=org.a11y.Bus /org/a11y/bus org.freedesktop.DBus.Properties.Set \
      string:org.a11y.Status string:IsEnabled variant:boolean:true 2>/dev/null && break
    sleep 0.1
  done
  nohup cua-driver serve --grant existing-profile >/tmp/cua-driver.log 2>&1 &
  cd /workspace || exit 1
  nohup xfwm4 >/tmp/xfwm4.log 2>&1 &
  nohup "$here/maximize.sh" >/tmp/maximize.log 2>&1 &
  nohup xfdesktop >/tmp/xfdesktop.log 2>&1 &
  sleep 0.5
  XFCE_PANEL_MIGRATE_DEFAULT=1 nohup xfce4-panel >/tmp/xfce4-panel.log 2>&1 &
  nohup "$here/browser.sh" >/tmp/browser.log 2>&1 &
fi
if [ "${1:-}" = --display ]; then
  for _ in $(seq 50); do (: </dev/tcp/127.0.0.1/5900) 2>/dev/null && exit 0; sleep 0.1; done
  echo "the VNC server did not start; see /tmp/xvnc.log" >&2
  exit 1
fi
. /run/crumble-desktop.env
for _ in $(seq 150); do
  cua-driver call list_windows '{}' 2>/dev/null | grep -q '"app_name": "Chromium' && exit 0
  sleep 0.2
done
echo "bot desktop did not start; see /tmp/*.log" >&2
exit 1
