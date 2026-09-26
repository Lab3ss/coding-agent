# coding-agent

Drive an autonomous coding agent from a chat app (Matrix) — from your phone,
anywhere. **One room = one project.** Invite the bot, tell it a repo, a GitHub
token, and a model — it clones the repo into its own isolated pod, codes,
commits, and opens PRs; you review the PRs from GitHub mobile.

## How it works

Two pieces:

- **The broker** (`src/broker.ts`) — a single, always-on, global bot. It holds
  no repo credentials of its own — only a Matrix account and an OpenRouter
  key. When invited to a new room, it asks for a repo, a GitHub PAT scoped to
  that repo, and a model (any OpenRouter model id), then provisions an
  isolated pod for that room via the Kubernetes API (`src/k8s.ts`).
  Internally it's split: the chat transport (Matrix today) is an adapter
  (`src/adapter/matrix.ts`) behind a transport-neutral contract
  (`src/adapter/types.ts`), and the platform-agnostic conversation logic —
  onboarding, commands, approval gates, provisioning, retries — is the
  orchestrator (`src/core/orchestrator.ts`, Effect-TS, see `src/core/`).
  Another chat platform is a new adapter; the core doesn't change.
- **The runner** (`runner/`) — a minimal, throwaway image. On start it clones
  the room's repo with the room's PAT and runs a headless `opencode serve`.
  No persistent storage: a fresh pod means a fresh clone and a fresh
  `opencode` session. The image bakes in opencode's global config
  (`runner/opencode.json`) with default agent rules
  (`runner/opencode-rules.md`); the chat channel's own formatting rules (e.g.
  plain-text-only for Matrix, since Matrix clients don't render markdown) are
  injected per pod by the broker from its adapter's capability profile
  (`AGENT_RULES`) and replace the baked-in default at startup.

The broker talks to each room's runner over HTTP (`src/opencode.ts`):
sending prompts, and relaying `opencode`'s own permission/approval prompts
(e.g. before `git push`) back into the room as a yes/no question.

## Usage

1. Invite the bot to a Matrix room.
2. Answer its three onboarding questions: repo, GitHub PAT, model.
3. Send tasks in plain language. The agent works and reports back.
4. `/stop` tears the room's pod down on demand. Idle rooms (default 24h, see
   `IDLE_TEARDOWN_HOURS`) tear down automatically. Either way the room's
   repo/token/model are remembered (`src/registry.ts`, a persistent SQLite
   file) — the next message re-provisions without re-asking, but starts a
   **fresh** `opencode` session (no PVC, so no conversation memory survives
   a teardown).
5. `/connect` (once a room's pod is up) replies with the exact
   `kubectl port-forward` + `opencode attach` commands to drive that same
   session from a local `opencode` TUI — useful for starting on your phone
   via Matrix, then switching to hands-on at a laptop with cluster access, and
   back. VPN/cluster-network only by design (the room's opencode server has no
   public exposure — see "Encryption" for the same reasoning applied to
   network access instead of transport encryption).
6. `/model <id>` changes the room's model (any OpenRouter model id — check
   [openrouter.ai/models](https://openrouter.ai/models) for the exact slug).
   Takes effect on your very next message, no pod restart — the model is
   sent per-message, never baked into the pod. `/model` with no argument
   shows the current one. Useful if onboarding was given an invalid model id
   (`/stop` alone does **not** fix this — it only tears down the pod, the
   remembered model is unchanged).
7. `/usage` reports the current session's cost, token breakdown
   (input/output/reasoning/cache), and whether the context has been
   compacted. Also shown automatically on `/stop`, and as a one-line alert
   every $5 spent. Some models/providers don't report cost — shown as "n/a"
   rather than failing.

## Config (env vars on the broker)

| Var | Purpose |
|-----|---------|
| `MATRIX_HOMESERVER`, `MATRIX_TOKEN` | the bot's Matrix account |
| `OPENROUTER_API_KEY` | the only LLM credential — copied into every room's pod at provision time |
| `ROOMS_NAMESPACE` | where per-room pods live; default `coding-agent-rooms` |
| `RUNNER_IMAGE` | the runner image tag to provision; default `ghcr.io/lab3ss/coding-agent-runner:0.2.0` |
| `IDLE_TEARDOWN_HOURS` | idle threshold before auto-teardown; default `24` |

## Safety

- **No standing repo access** — the broker holds nothing that can reach a
  GitHub repo; each room's PAT lives only in that room's Secret, inside that
  room's own pod, deleted on teardown.
- **Untrusted-workload boundary** — runner pods are non-root, have no
  Kubernetes API access (`automountServiceAccountToken: false`), and run in a
  dedicated namespace the broker can create/delete Pods/Secrets/Services in
  and nothing else can reach.
- **Approval gate** — `opencode`'s own permission prompts (shell commands,
  `git push`, etc.) pause and ask in the room before running. No timeout — it
  waits as long as it takes.
- **Token redacted after read** — the PAT message is redacted from room
  history right after the broker reads it (best-effort — not a substitute for
  room encryption; see "Encryption" below).

## Encryption

Rooms are onboarded **unencrypted** — `matrix-bot-sdk` here has no E2EE
crypto provider wired in, so it can't decrypt messages in an encrypted room.
Turn off encryption when creating/inviting the bot to a room. Redacting the
PAT message (above) reduces plaintext exposure in room history but doesn't
replace transport encryption; see the GitOps repo's `docs/coding-agent.md`
for the fuller tradeoff discussion.

## Requirements

Node 22+ (native TypeScript execution, no build step; uses built-in
`node:sqlite`). The broker needs in-cluster Kubernetes API access
(`@kubernetes/client-node`, auto-configured via the pod's ServiceAccount — see
the GitOps repo's RBAC). The runner needs `git` and `opencode-ai` on PATH
(baked into its image).

## Deployment

Runs in production on a K3s cluster, managed by Flux (GitOps): one broker
Deployment plus dynamically-created per-room Pods/Secrets/Services. Two
images, both `linux/amd64`:

- `ghcr.io/lab3ss/coding-agent` — the broker (this repo's `Dockerfile`).
- `ghcr.io/lab3ss/coding-agent-runner` — the runner (`runner/Dockerfile`).

All Kubernetes manifests, SOPS-encrypted secrets, and operational notes live
in the GitOps repo:

- **`Lab3ss/k3s-gitops`** → `apps/coding-agent/` (broker + RBAC) and
  `apps/coding-agent-rooms/` (namespace only — pods/secrets/services there are
  created dynamically, not via GitOps) and **`docs/coding-agent.md`**
  (deployment, day-2 ops, rebuild, open items — **start there when resuming
  work**).

Shipping a code change: rebuild + push whichever image changed for
`linux/amd64`, bump its tag in the GitOps repo, commit, and reconcile.

```sh
# 1. Ship the code
git push origin main

# 2. Build + push the broker image (swap Dockerfile/image name for the runner)
VERSION=X.X.XX
docker buildx build --platform linux/amd64 -t ghcr.io/lab3ss/coding-agent:$VERSION --push .

# 3. Bump the tag in the GitOps repo
git clone --depth 1 https://github.com/Lab3ss/k3s-gitops.git /tmp/k3s-gitops-deploy
cd /tmp/k3s-gitops-deploy
sed -i '' "s|ghcr.io/lab3ss/coding-agent:.*|ghcr.io/lab3ss/coding-agent:$VERSION|" apps/coding-agent/deployment.yaml
git commit -am "chore: bump coding-agent to $VERSION"
git push origin main

# 4. Force an immediate rollout instead of waiting for Flux's poll interval
flux reconcile kustomization apps -n flux-system --with-source

# 5. Verify
kubectl rollout status -n coding-agent deploy/coding-agent
kubectl get deploy -n coding-agent coding-agent -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

`strategy: Recreate` on the Deployment means the old broker pod stops before
the new one starts — any in-flight room task gets interrupted (the SQLite
registry is on a PVC, so nothing is lost; the room just re-provisions on its
next message).
