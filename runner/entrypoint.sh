#!/bin/sh
set -eu

: "${REPO:?REPO env var required}"       # always "owner/name" — the broker normalizes it
: "${GH_TOKEN:?GH_TOKEN env var required}"

WORKDIR=/home/node/workspace
git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$WORKDIR"
cd "$WORKDIR"

exec opencode serve --hostname 0.0.0.0 --port "${PORT:-4096}"
