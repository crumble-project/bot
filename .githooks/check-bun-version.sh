#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
expected=$(cat "$root/.bun-version")
actual=$(bun --version)
if [ "$actual" != "$expected" ]; then
  echo "Bun $actual is installed, but CI runs Bun $expected (.bun-version). Install Bun $expected." >&2
  exit 1
fi
