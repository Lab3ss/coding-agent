# Coding-agent image — one image, run one instance per scope (arg: personal | pro | ...).
# Config is injected as env vars (k8s Secret); no .env files or secrets are baked in.
FROM node:22-bookworm-slim

# System deps the agent needs: git + GitHub CLI (gh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI — the Agent SDK drives it under the hood.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

# Persistent state (SQLite registry, workspaces, bot-state) lives under /data.
# Running with cwd=/data means the broker's relative paths land on the volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
WORKDIR /data
ENTRYPOINT ["node", "/app/src/broker.ts"]
