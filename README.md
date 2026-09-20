# coding-agent

Drive an autonomous Claude Code agent from a chat app (Matrix) — from your phone,
anywhere. **One room = one project = one repo = one durable Claude session.** The
agent clones, codes, commits, and opens PRs; you review the PRs from GitHub mobile.

## How it works

One scope-agnostic broker process. You run **one instance per scope** (identity),
each with its own credentials, so a personal instance can never touch a
professional repo — the wall is the credential it holds, not a rule.

```
node src/broker.ts personal   # loads .env.personal
node src/broker.ts pro        # loads .env.pro
```

Per scope you provide (in `.env.<scope>`, gitignored — see `.env.example`):

| Var | Purpose |
|-----|---------|
| `MATRIX_HOMESERVER`, `MATRIX_TOKEN` | this scope's dedicated bot account |
| `GH_TOKEN` | fine-grained PAT scoped to ONLY this scope's repos (the isolation wall) |
| `ANTHROPIC_API_KEY` | this scope's Anthropic key (per-scope billing); blank = local CLI login |
| `GIT_USER_NAME`, `GIT_USER_EMAIL` | commit identity for this scope |
| `WORKSPACE_ROOT` | where this scope's clones live (never shared) |
| `DAILY_USD_LIMIT` | max spend per project per day; `0`/blank = unlimited |
| `MODEL` | e.g. `claude-sonnet-4-6` (cheaper); blank = Opus default |
| `SCOPE_LABEL` | label for logs |

## Usage

1. Invite the scope's bot to a Matrix room.
2. Send a repo (`owner/name`) to onboard it — the broker clones it.
3. Send tasks in plain language. The agent works and reports back.

State (project → repo/session mapping) persists in a per-scope SQLite registry, so
restarts resume where you left off.

## Safety

- **Credential isolation** — each instance holds only its own PAT; scoped so it
  can't reach another scope's repos.
- **Approval gate** — `git push`, `gh pr create`/`merge`, and destructive shell
  (`rm -rf`, `git reset --hard`, `git clean -f`, `sudo`) pause and ask for approval
  in the room before running. No timeout — it waits as long as it takes.
- **Cost cap** — per-project daily USD limit.

## Requirements

Node 22+ (uses built-in `node:sqlite` and `process.loadEnvFile`), the `claude`
CLI, `git`, and `gh` on PATH.

## Deployment

Runs in production on a K3s cluster, managed by Flux (GitOps), one Deployment per
scope. The image is `ghcr.io/lab3ss/coding-agent` (built `linux/amd64`). All the
Kubernetes manifests, SOPS-encrypted secrets, and operational notes live in the
GitOps repo:

- **`Lab3ss/k3s-gitops`** → `apps/coding-agent/` (manifests) and
  **`docs/coding-agent.md`** (deployment, day-2 ops, rebuild, open items —
  **start there when resuming work**).

Shipping a code change: rebuild + push the image for `linux/amd64`, bump the tag
in both deployments in the GitOps repo, commit, and reconcile.
