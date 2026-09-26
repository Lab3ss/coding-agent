# coding-agent

Drive [opencode](https://opencode.ai) from your chat app. Send a task in
natural language to a Matrix room — the agent codes, commits, and opens a PR;
you review from GitHub mobile. **One room = one project.**

## Why

- **Code from your phone** — the interface is your messenger, not an IDE.
  `/connect` even lets you hand a session over to opencode's local TUI on a
  laptop, and back.
- **Ephemeral by design** — each room gets its own isolated, non-root pod,
  torn down after 24h idle. No stateful agent to operate.
- **Compartmentalized security** — the GitHub PAT lives only in its own pod's
  Secret and is deleted on teardown; the broker can reach no repo itself. An
  approval gate stands before `git push` and shell commands.
- **Sovereignty** — any OpenRouter model, switchable mid-session
  (`/model`), usage tracking (`/usage`), self-hosted on your own cluster.
  No closed SaaS, no vendor pricing, no locked-in models.
- **Multi-project** — one room per project, all served by a single broker.

## How it works

Two pieces:

- **The broker** — a single always-on bot holding only a Matrix account and
  an OpenRouter key. When invited to a new room it asks for a repo, a GitHub
  PAT scoped to that repo, and a model, then provisions an isolated pod for
  that room. Chat transport is an adapter; the conversation logic is
  transport-neutral, so another chat platform is a new adapter and nothing
  else.
- **The runner** — a minimal throwaway image that clones the room's repo and
  runs a headless `opencode serve`. Nothing persists: a fresh pod means a
  fresh clone and a fresh session. The broker relays opencode's own
  permission prompts (shell commands, `git push`, …) back into the room as
  yes/no questions.

## Usage

1. Invite the bot to an **unencrypted** Matrix room (E2EE is not supported —
   see [Security](#security)).
2. Answer its three onboarding questions: repo, GitHub PAT, model.
3. Send tasks in plain language. The agent works and reports back.

Commands:

- `/model [id]` — show or change the room's model (any
  [OpenRouter](https://openrouter.ai/models) model id), effective on the next
  message.
- `/usage` — session cost, token breakdown, context-compaction status.
  A one-line alert every $5 spent.
- `/connect` — replies with the `kubectl port-forward` + `opencode attach`
  commands to drive the same session from a local opencode TUI (VPN/cluster
  network required).
- `/stop` — tear the room's pod down on demand. Idle rooms tear down
  automatically after `IDLE_TEARDOWN_HOURS`. The room's repo/token/model are
  remembered, so the next message re-provisions without re-asking — but
  starts a **fresh** session (no conversation memory survives a teardown).

## Deploying your own

Requirements: a Kubernetes cluster (runs on K3s), Node 22+ if building the
broker image yourself, a Matrix account for the bot, an
[OpenRouter](https://openrouter.ai) API key, and GitHub PATs scoped to the
repos you'll onboard.

Two images, both `linux/amd64`:

- `ghcr.io/lab3ss/coding-agent` — the broker (built from this repo's
  `Dockerfile`).
- `ghcr.io/lab3ss/coding-agent-runner` — the runner (built from
  `runner/Dockerfile`).

Deploy the broker as a single Deployment with these env vars (a k8s Secret
via `envFrom` works well):

| Var | Purpose |
|-----|---------|
| `MATRIX_HOMESERVER`, `MATRIX_TOKEN` | the bot's Matrix account |
| `OPENROUTER_API_KEY` | the only LLM credential, copied into every room's pod |
| `ROOMS_NAMESPACE` | where per-room pods live; default `coding-agent-rooms` |
| `RUNNER_IMAGE` | runner image tag; default `ghcr.io/lab3ss/coding-agent-runner:0.2.1` |
| `IDLE_TEARDOWN_HOURS` | idle threshold before auto-teardown; default `24` |

Notes:

- The broker must run **in-cluster** (it uses the pod's ServiceAccount to
  create Pods/Secrets/Services in `ROOMS_NAMESPACE` — set up the RBAC for
  that namespace and nothing more).
- The broker's registry (SQLite) should live on a PVC so room configs
  survive restarts.
- Use a `Recreate` strategy: a restart interrupts in-flight tasks, but
  nothing is lost — rooms re-provision on their next message.

For local development without a cluster, copy `.env.example` to `.env` and
run `npm run broker` (Kubernetes calls still need in-cluster access, so
testing against a deployed pod is the practical path).

## Security

- **No standing repo access** — the broker holds nothing that can reach a
  GitHub repo; each room's PAT lives only in that room's Secret, inside that
  room's pod, deleted on teardown.
- **Untrusted-workload boundary** — runner pods are non-root, have no
  Kubernetes API access (`automountServiceAccountToken: false`), and run in
  a dedicated namespace only the broker can reach.
- **Approval gate** — opencode's permission prompts (shell commands,
  `git push`, etc.) pause and ask in the room before running.
- **Rooms are unencrypted** — `matrix-bot-sdk` has no E2EE provider wired
  in, so the bot can't decrypt messages in an encrypted room. The PAT
  message is redacted from room history right after the broker reads it
  (best-effort), which reduces plaintext exposure but doesn't replace
  transport encryption. Don't onboard repos whose PAT in room history is
  unacceptable to you.

## Development

```sh
npm install
npm run check   # typecheck
npm test        # unit tests
docker buildx build --platform linux/amd64 -t ghcr.io/lab3ss/coding-agent:X.Y.Z --push .
```

## License

MIT
