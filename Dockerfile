# Coding-agent broker — single global instance. Talks to Matrix, the k8s API
# (to provision/tear down per-room pods) and each room's opencode server over
# HTTP. It never clones a repo or runs git/gh itself — that's runner/'s job,
# inside the untrusted per-room pod — so this image stays minimal.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

# Persistent state (SQLite registry, Matrix sync token) lives under /data.
# Running with cwd=/data means the broker's relative paths land on the volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
WORKDIR /data
ENTRYPOINT ["node", "/app/src/broker.ts"]
