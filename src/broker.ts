/**
 * Broker — scope-agnostic. ONE codebase, run ONE instance per scope.
 *
 * Each instance gets its whole identity from an env file and can ONLY touch the
 * repos that its PAT is scoped to. The personal instance never holds the pro PAT,
 * so it's structurally impossible for it to reach pro repos.
 *
 * Run one instance per scope:
 *   node src/broker.ts personal      # loads .env.personal
 *   node src/broker.ts pro           # loads .env.pro
 *   node src/broker.ts               # loads .env  (fallback)
 *
 * Each .env.<scope> provides:
 *   MATRIX_HOMESERVER, MATRIX_TOKEN   -> this scope's bot account
 *   GH_TOKEN                          -> this scope's fine-grained PAT (the wall)
 *   GIT_USER_NAME, GIT_USER_EMAIL     -> commit identity for this scope
 *   WORKSPACE_ROOT                    -> where this scope's clones live
 *   SCOPE_LABEL                       -> just for logging
 */
import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } from "matrix-bot-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

// --- Load this instance's identity ---
const scope = process.argv[2];
const envFile = scope ? `.env.${scope}` : ".env";
process.loadEnvFile(envFile);

const label = process.env.SCOPE_LABEL ?? scope ?? "default";
const homeserver = process.env.MATRIX_HOMESERVER!;
const matrixToken = process.env.MATRIX_TOKEN!;
const ghToken = process.env.GH_TOKEN!;
const workspaceRoot = process.env.WORKSPACE_ROOT ?? `workspaces-${label}`;
const dailyLimitUsd = parseFloat(process.env.DAILY_USD_LIMIT ?? "0"); // 0 / unset = no limit
const model = process.env.MODEL || undefined; // unset = inherit Claude Code default (Opus)

if (!homeserver || !matrixToken) throw new Error(`${envFile}: MATRIX_HOMESERVER and MATRIX_TOKEN required`);
if (!ghToken) throw new Error(`${envFile}: GH_TOKEN (this scope's PAT) required`);

// --- Pin git/gh auth + commit identity to THIS scope, for us AND the agent ---
// GH_TOKEN is already in process.env (from the env file). Child processes the
// agent spawns (its Bash tool) inherit it, so every git/gh call uses this PAT.
if (process.env.GIT_USER_NAME) {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = process.env.GIT_USER_NAME;
}
if (process.env.GIT_USER_EMAIL) {
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = process.env.GIT_USER_EMAIL;
}
// Make `git push` use gh's credential helper (which resolves GH_TOKEN).
try {
  execSync("gh auth setup-git", { stdio: "ignore", env: process.env });
} catch (e) {
  console.warn("gh auth setup-git failed (continuing):", (e as any)?.message);
}

type Project = { repo: string; workdir: string; sessionId?: string; busy: boolean };
const projects = new Map<string, Project>();

const client = new MatrixClient(homeserver, matrixToken, new SimpleFsStorageProvider(`bot-state-${label}.json`));
AutojoinRoomsMixin.setupOnClient(client);
const startedAt = Date.now();
const me = await client.getUserId();
// The Agent SDK / claude CLI reads ANTHROPIC_API_KEY from the environment, which
// loadEnvFile() populated per scope — so personal and pro bill their own keys.
const anthropicAuth = process.env.ANTHROPIC_API_KEY ? "api-key" : "CLI login";
console.log(
  `[${label}] broker up as ${me} on ${homeserver} | workspaces=${workspaceRoot} | model=${model ?? "default(opus)"} | anthropic=${anthropicAuth} | GH_TOKEN=present`,
);

function parseRepo(text: string): string | null {
  const t = text.trim();
  const url = t.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (url) return url[1];
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return t;
  return null;
}
const safeName = (roomId: string) => roomId.replace(/[^a-zA-Z0-9]/g, "_");

// --- Per-project daily spend ledger (this scope; resets each UTC day) ---
// Keyed by room so all activity on a project — including future multi-role bots
// sharing the channel — draws from one daily pool. (Move to the shared registry/DB
// once roles run as separate processes, so the cap holds across all of them.)
const usageFile = `usage-${label}.json`;
const today = () => new Date().toISOString().slice(0, 10);
type Usage = { date: string; spent: Record<string, number> };
let usage: Usage = { date: today(), spent: {} };
try {
  usage = JSON.parse(readFileSync(usageFile, "utf8"));
} catch {}
function rollDay() {
  if (usage.date !== today()) usage = { date: today(), spent: {} };
}
function spentToday(room: string): number {
  rollDay();
  return usage.spent[room] ?? 0;
}
function addSpend(room: string, cost: number) {
  rollDay();
  usage.spent[room] = (usage.spent[room] ?? 0) + cost;
  writeFileSync(usageFile, JSON.stringify(usage));
}

// --- Persistent registry (per scope): room -> {repo, workdir, session_id} ---
// Survives restarts, so projects and Claude sessions resume instead of resetting.
// Single-process per scope today; the shared multi-role future moves this to the
// cluster DB (CloudNativePG) so all role-bots see one registry.
const db = new DatabaseSync(`registry-${label}.db`);
db.exec(
  `CREATE TABLE IF NOT EXISTS projects (
     room_id TEXT PRIMARY KEY, repo TEXT NOT NULL, workdir TEXT NOT NULL, session_id TEXT
   )`,
);
function saveProject(roomId: string, p: Project) {
  db.prepare(
    `INSERT INTO projects(room_id, repo, workdir, session_id) VALUES(?, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET repo=excluded.repo, workdir=excluded.workdir, session_id=excluded.session_id`,
  ).run(roomId, p.repo, p.workdir, p.sessionId ?? null);
}
for (const row of db.prepare(`SELECT room_id, repo, workdir, session_id FROM projects`).all() as any[]) {
  projects.set(row.room_id, { repo: row.repo, workdir: row.workdir, sessionId: row.session_id ?? undefined, busy: false });
}
if (projects.size) console.log(`[${label}] restored ${projects.size} project(s) from registry`);

/** Re-clone if the workdir is gone (e.g. a fresh pod with an empty volume). */
function ensureClone(p: Project) {
  if (existsSync(p.workdir)) return;
  mkdirSync(workspaceRoot, { recursive: true });
  execSync(`gh repo clone ${p.repo} ${JSON.stringify(p.workdir)}`, { stdio: "inherit", env: process.env });
}

// --- Step 6: approval gate for outbound/destructive actions ---
// A room awaiting approval has a resolver here; its next message answers it.
const pendingApprovals = new Map<string, (approved: boolean) => void>();

// Only these (all Bash) require a phone tap. Everything else runs freely.
const RISKY: Array<{ re: RegExp; label: string }> = [
  { re: /\bgit\s+push\b/, label: "git push (upload to GitHub)" },
  { re: /\bgh\s+pr\s+(create|merge)\b/, label: "open / merge a pull request" },
  { re: /\brm\s+-[rf]/, label: "rm -r/-f (delete files)" },
  { re: /\bgit\s+reset\s+--hard\b/, label: "git reset --hard (discard changes)" },
  { re: /\bgit\s+clean\s+-[a-z]*f/, label: "git clean -f (delete untracked files)" },
  { re: /\bsudo\b/, label: "sudo (elevated privileges)" },
];

function riskyCommand(toolName: string, input: Record<string, unknown>): { cmd: string; reason: string } | null {
  if (toolName !== "Bash") return null; // only shell commands can push/PR/delete
  const cmd = String((input as any).command ?? "");
  const hit = RISKY.find((r) => r.re.test(cmd));
  return hit ? { cmd, reason: hit.label } : null;
}

// Posts an approval request and waits INDEFINITELY for the user's reply — no
// timeout by design: if you're asleep or driving, the action just waits.
function askApproval(roomId: string, cmd: string, reason: string): Promise<boolean> {
  client.sendText(
    roomId,
    `🔐 Approval needed — flagged: *${reason}*\nCommand:\n\`${cmd}\`\nReply *yes* to allow, anything else to deny. No rush — I'll wait as long as it takes.`,
  );
  return new Promise((resolve) => pendingApprovals.set(roomId, resolve));
}

// The SDK calls this before any tool that isn't pre-allowed. Bash lands here.
function makeGate(roomId: string) {
  return async (toolName: string, input: Record<string, unknown>) => {
    const hit = riskyCommand(toolName, input);
    if (!hit) return { behavior: "allow" as const, updatedInput: input };
    const approved = await askApproval(roomId, hit.cmd, hit.reason);
    return approved
      ? { behavior: "allow" as const, updatedInput: input }
      : { behavior: "deny" as const, message: "The user denied this action. Do not retry it — find another approach or stop and explain." };
  };
}

async function runTask(roomId: string, p: Project, task: string) {
  await client.sendText(roomId, "🛠️ on it…");
  const prompt = `You are an autonomous coding agent in a local clone of ${p.repo} (the current
working directory). origin is authenticated. Work on a branch and open/update a PR
with the gh CLI for anything worth sharing; never push to main directly. Be concise.

Run shell commands one operation at a time. In particular, run \`git push\` and
\`gh pr create\` as their OWN standalone commands — never chain them together with
add/commit/diff/cd in a single invocation. (Those two require human approval, and
bundling them forces the safe steps to wait on it too.)

Request: ${task}`;

  let finalText = "";
  let cost = 0;
  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: p.workdir,
        resume: p.sessionId,
        model, // e.g. claude-sonnet-4-6 to cut cost ~60% vs Opus; unset = Opus default
        // Safe tools run freely. Bash is NOT pre-allowed, so every shell command
        // routes through the gate, which allows it or asks for a phone tap.
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
        canUseTool: makeGate(roomId),
        maxTurns: 40,
      },
    })) {
      p.sessionId = (msg as any).session_id ?? p.sessionId;
      if (msg.type === "result") {
        finalText = msg.subtype === "success" ? msg.result : `(run ended: ${msg.subtype})`;
        if (msg.subtype === "success") cost = msg.total_cost_usd;
      }
    }
  } catch (err: any) {
    finalText = `⚠️ error: ${err?.message ?? err}`;
  }
  await client.sendText(roomId, finalText || "(no output)");
  return cost;
}

client.on("room.message", async (roomId: string, event: any) => {
  if (event.sender === me) return;
  if (!event.content || event.content.msgtype !== "m.text") return;
  if ((event.origin_server_ts ?? 0) < startedAt) return;

  const body: string = (event.content.body ?? "").trim();

  // If this room is waiting on an approval, this message IS the answer.
  const pending = pendingApprovals.get(roomId);
  if (pending) {
    pendingApprovals.delete(roomId);
    const approved = /^(y|yes|ok|okay|approve|approved|go|sure|👍|✅)\b/i.test(body);
    await client.sendText(roomId, approved ? "✅ Approved — proceeding." : "🚫 Denied.");
    pending(approved);
    return;
  }

  let p = projects.get(roomId);

  if (!p) {
    const repo = parseRepo(body);
    if (!repo) {
      await client.sendText(roomId, `[${label}] No project yet. Reply with a repo, e.g. \`owner/name\`.`);
      return;
    }
    const workdir = resolve(workspaceRoot, safeName(roomId));
    try {
      await client.sendText(roomId, `Cloning ${repo}…`);
      mkdirSync(workspaceRoot, { recursive: true });
      if (!existsSync(workdir)) {
        // Uses GH_TOKEN (this scope's PAT) -> 403 if the repo isn't in its scope.
        execSync(`gh repo clone ${repo} ${JSON.stringify(workdir)}`, { stdio: "inherit", env: process.env });
      }
      p = { repo, workdir, busy: false };
      projects.set(roomId, p);
      saveProject(roomId, p);
      await client.sendText(roomId, `✅ [${label}] ${repo} ready. What would you like me to do?`);
    } catch (err: any) {
      await client.sendText(roomId, `⚠️ couldn't clone ${repo} (out of this scope's PAT?): ${err?.message ?? err}`);
    }
    return;
  }

  if (p.busy) {
    await client.sendText(roomId, "Still working on the previous request — one moment.");
    return;
  }

  // Daily budget gate (soft: blocks starting a new task once the cap is reached;
  // a single in-flight task can overshoot — maxTurns bounds how far).
  if (dailyLimitUsd > 0 && spentToday(roomId) >= dailyLimitUsd) {
    await client.sendText(
      roomId,
      `🛑 Daily budget reached for this project ($${spentToday(roomId).toFixed(2)} / $${dailyLimitUsd.toFixed(2)}). Resets at 00:00 UTC.`,
    );
    return;
  }

  p.busy = true;
  try {
    ensureClone(p);
    const cost = await runTask(roomId, p, body);
    saveProject(roomId, p); // persist any new/updated session_id
    if (cost > 0) {
      addSpend(roomId, cost);
      const note =
        dailyLimitUsd > 0
          ? `💸 $${cost.toFixed(4)} this task · $${spentToday(roomId).toFixed(2)} / $${dailyLimitUsd.toFixed(2)} today`
          : `💸 $${cost.toFixed(4)} this task`;
      await client.sendText(roomId, note);
    }
  } catch (err: any) {
    await client.sendText(roomId, `⚠️ ${err?.message ?? err}`);
  } finally {
    p.busy = false;
  }
});

await client.start();
console.log(`[${label}] listening. Send a repo to onboard, then send tasks.`);
