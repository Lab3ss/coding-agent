# Room runner — one ephemeral pod per Matrix room, no persistent storage.
# Clones the room's repo (GH_TOKEN from env, supplied at onboarding, never
# baked into the image) and runs a headless opencode server on the room's
# chosen model/provider; the broker drives it over HTTP (see src/opencode.ts).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown node:node /entrypoint.sh

# Matrix-specific agent rules, baked in as opencode's global config so they
# apply to every room's session no matter which repo is cloned (the repo's own
# AGENTS.md still merges on top; see opencode-rules.md — currently: plain-text
# replies only, since Matrix clients don't render markdown).
COPY opencode.json /home/node/.config/opencode/opencode.json
COPY opencode-rules.md /home/node/.config/opencode/opencode-rules.md
RUN chown node:node /home/node/.config/opencode/opencode.json \
                     /home/node/.config/opencode/opencode-rules.md

USER node
WORKDIR /home/node
ENTRYPOINT ["/entrypoint.sh"]
