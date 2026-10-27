#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/crumble-contract.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

git checkout-index --all --prefix="$tmp/"
ln -s "$root/node_modules" "$tmp/node_modules"
ln -s "$root/apps/server/node_modules" "$tmp/apps/server/node_modules"
rm -f "$tmp/openapi/openapi.json" "$tmp"/openapi/*.schema.json
(cd "$tmp" && bun apps/server/src/contract/openapi.ts)

for generated in "$tmp/openapi/openapi.json" "$tmp"/openapi/*.schema.json; do
  [ -f "$generated" ] || continue
  path="openapi/${generated##*/}"
  old="$tmp/old-artifact"
  if git show ":$path" > "$old" 2>/dev/null; then
    if cmp -s "$old" "$generated"; then continue; fi
    if [ -f "$root/$path" ] && cmp -s "$root/$path" "$old"; then
      cp "$generated" "$root/$path"
    fi
  elif [ ! -e "$root/$path" ]; then
    cp "$generated" "$root/$path"
  fi
  hash=$(git hash-object -w "$generated")
  git update-index --add --cacheinfo "100644,$hash,$path"
done

for path in $(git ls-files -- 'openapi/*.schema.json'); do
  if [ ! -f "$tmp/$path" ]; then
    old="$tmp/old-artifact"
    git show ":$path" > "$old"
    if [ -f "$root/$path" ] && cmp -s "$root/$path" "$old"; then
      rm "$root/$path"
    fi
    git update-index --force-remove -- "$path"
  fi
done
