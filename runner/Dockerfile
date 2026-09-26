# Room runner — one ephemeral pod per Matrix room, no persistent storage.
# Clones the room's repo (GH_TOKEN from env, supplied at onboarding, never
# baked into the image) and runs a headless opencode server on the room's
# chosen model/provider; the broker drives it over HTTP (see src/opencode.ts).
FROM node:22-bookworm-slim

# Pin the opencode version: an unpinned `npm install -g opencode-ai` makes
# every image rebuild a potential silent major-version jump (breaking runner
# behavior/APIs between otherwise identical deployments). Bump deliberately.
ARG OPENCODE_VERSION=1.18.32

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit "opencode-ai@${OPENCODE_VERSION}"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown node:node /entrypoint.sh

# Matrix-specific agent rules, baked in as opencode's global config so they
# apply to every room's session no matter which repo is cloned (the repo's own
# AGENTS.md still merges on top; see opencode-rules.md — currently: plain-text
# replies only, since Matrix clients don't render markdown).
COPY opencode.json /home/node/.config/opencode/opencode.json
COPY opencode-rules.md /home/node/.config/opencode/opencode-rules.md
# chown the directory itself, not just these two files: entrypoint.sh writes a
# new channel-rules.md into it at runtime as `node`, which needs dir write
# permission, not just file ownership.
RUN chown -R node:node /home/node/.config/opencode

USER node
WORKDIR /home/node
ENTRYPOINT ["/entrypoint.sh"]
