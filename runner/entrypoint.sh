#!/bin/sh
set -eu

: "${REPO:?REPO env var required}"       # always "owner/name" — the broker normalizes it
: "${GH_TOKEN:?GH_TOKEN env var required}"

# The chat channel's formatting capability profile (e.g. Matrix needs
# plain-text-only agent output) is injected by the broker as AGENT_RULES.
# When present it REPLACES the baked-in default (opencode-rules.md), which
# exists only for standalone/manual pods not provisioned by the broker.
if [ -n "${AGENT_RULES:-}" ]; then
  echo "[runner] applying channel agent rules from env..."
  printf '%s\n' "$AGENT_RULES" > /home/node/.config/opencode/channel-rules.md
  printf '%s\n' '{"$schema": "https://opencode.ai/config.json", "instructions": ["/home/node/.config/opencode/channel-rules.md"]}' \
    > /home/node/.config/opencode/opencode.json
fi

WORKDIR=/home/node/workspace
echo "[runner] cloning ${REPO}..."
git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$WORKDIR"
cd "$WORKDIR"

echo "[runner] starting opencode server on port ${PORT:-4096}..."
exec opencode serve --hostname 0.0.0.0 --port "${PORT:-4096}"
