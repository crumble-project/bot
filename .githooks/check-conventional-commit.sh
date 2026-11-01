#!/bin/sh
# Shared by the commit-msg hook and the PR title workflow, so both accept the same messages.
set -eu

subject=$1
pattern='^(feat|fix|perf|refactor|docs|test|build|ci|chore)(\([a-z0-9/-]+\))?!?: [^ ].*$'
if ! printf '%s\n' "$subject" | grep -Eq "$pattern"; then
  cat >&2 <<MESSAGE
"$subject" is not a Conventional Commit.
Use <type>(<scope>): <description>, where type is one of
feat, fix, perf, refactor, docs, test, build, ci, or chore. See CONTRIBUTING.md.
MESSAGE
  exit 1
fi
