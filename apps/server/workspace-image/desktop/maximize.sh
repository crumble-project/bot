#!/bin/bash
. /run/crumble-desktop.env
declare -A seen
until xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; do sleep 0.2; done
stdbuf -oL xprop -root -spy _NET_CLIENT_LIST | while read -r line; do
  declare -A open=()
  for id in $(grep -o '0x[0-9a-f]*' <<<"$line"); do
    open[$id]=1
    [ -n "${seen[$id]:-}" ] && continue
    seen[$id]=1
    case "$(xprop -id "$id" _NET_WM_WINDOW_TYPE 2>/dev/null)" in *_NORMAL* | *"not found"*) ;; *) continue ;; esac
    xprop -id "$id" WM_TRANSIENT_FOR 2>/dev/null | grep -q 'window id' && continue
    (for _ in $(seq 10); do
      wmctrl -i -r "$id" -b add,maximized_vert,maximized_horz 2>/dev/null
      sleep 0.2
      xprop -id "$id" _NET_WM_STATE 2>/dev/null | grep -q MAXIMIZED_VERT && break
    done) &
  done
  for id in "${!seen[@]}"; do [ -n "${open[$id]:-}" ] || unset "seen[$id]"; done
  unset open
done
