#!/bin/bash
# Maximizes each new app window once, as the old Openbox rule did (xfwm4 has no such rule).
# A window the job or the owner restores stays restored; dialogs keep their size.
. /run/crumble-desktop.env
declare -A seen
# Spying before xfwm4 manages the screen misses every later event.
until xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; do sleep 0.2; done
# stdbuf: xprop buffers its output into a pipe, which would hold back every event.
stdbuf -oL xprop -root -spy _NET_CLIENT_LIST | while read -r line; do
  declare -A open=()
  for id in $(grep -o '0x[0-9a-f]*' <<<"$line"); do
    open[$id]=1
    [ -n "${seen[$id]:-}" ] && continue
    seen[$id]=1
    case "$(xprop -id "$id" _NET_WM_WINDOW_TYPE 2>/dev/null)" in *_NORMAL* | *"not found"*) ;; *) continue ;; esac
    xprop -id "$id" WM_TRANSIENT_FOR 2>/dev/null | grep -q 'window id' && continue
    # xfwm4 drops a request that arrives while it still places the window, so retry briefly.
    (for _ in $(seq 10); do
      wmctrl -i -r "$id" -b add,maximized_vert,maximized_horz 2>/dev/null
      sleep 0.2
      xprop -id "$id" _NET_WM_STATE 2>/dev/null | grep -q MAXIMIZED_VERT && break
    done) &
  done
  # The X server reuses a closed window's ID, so a later window with it is new.
  for id in "${!seen[@]}"; do [ -n "${open[$id]:-}" ] || unset "seen[$id]"; done
  unset open
done
