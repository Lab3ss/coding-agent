/**
 * Step 1 — prove the agent loop, hardcoded, no Matrix yet.
 *
 * Given a repo and a task, this:
 *   1. clones the repo into ./workspaces/<name> (via the authenticated `gh` CLI),
 *   2. runs the Claude Agent SDK with cwd = that clone,
 *   3. the agent makes the change, branches, commits, pushes, and opens a PR.
 *
 * Run:  node src/step1.ts <owner/repo> ["task description"]
 * e.g.  node src/step1.ts Lab3ss/broker-sandbox
 *
 * Auth: the SDK drives the local `claude` CLI (already logged in); git/gh use your
 * existing `gh` authentication. No tokens here — that hardening is Step 7.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = process.argv[2] ?? "Lab3ss/broker-sandbox";
const task =
  process.argv[3] ??
  "Append a short line to README.md under a new '## Broker test' heading confirming the broker opened this PR successfully, and include today's date.";

const name = repo.split("/").pop()!.replace(/\.git$/, "");
const workdir = resolve("workspaces", name);

// --- 1. Ensure a fresh-ish clone exists (the broker will manage this per-room later) ---
mkdirSync("workspaces", { recursive: true });
if (!existsSync(workdir)) {
  console.log(`Cloning ${repo} -> ${workdir}`);
  execSync(`gh repo clone ${repo} ${JSON.stringify(workdir)}`, { stdio: "inherit" });
} else {
  console.log(`Reusing existing clone at ${workdir} (pulling latest main)`);
  execSync(`git -C ${JSON.stringify(workdir)} checkout main && git -C ${JSON.stringify(workdir)} pull --ff-only`, {
    stdio: "inherit",
  });
}

// --- 2. Run the agent against the clone ---
const prompt = `You are working inside a local git clone of the repository ${repo}.
The current working directory IS that clone. The default branch is "main" and the
remote "origin" is already authenticated for push and for the gh CLI.

Task: ${task}

Carry this out end to end, using Bash for git and gh:
1. Create and switch to a new branch (name it like "broker/step1-<short-timestamp>").
2. Make the change described in the task.
3. Commit it with a clear, concise message.
4. Push the branch to origin.
5. Open a pull request against main with the gh CLI (e.g. \`gh pr create --fill\`).
Finally, print the pull request URL on its own line.`;

console.log(`\n=== Running agent on ${repo} ===\n`);

let sessionId = "";
let prCandidate = "";

for await (const msg of query({
  prompt,
  options: {
    cwd: workdir,
    // Step 1 is an unattended smoke test on a throwaway repo, so we let it run
    // without prompts. Steps 6–7 replace this with a phone-approval gate
    // (PreToolUse / canUseTool) for push, PR, and destructive commands.
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    maxTurns: 40,
    stderr: (d) => process.stderr.write(d),
  },
})) {
  sessionId = (msg as any).session_id ?? sessionId;

  if (msg.type === "system" && msg.subtype === "init") {
    console.log(`[session ${msg.session_id}] model=${msg.model}\n`);
  } else if (msg.type === "assistant") {
    for (const block of msg.message.content as any[]) {
      if (block.type === "text") {
        process.stdout.write(block.text);
        const m = block.text.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
        if (m) prCandidate = m[0];
      } else if (block.type === "tool_use") {
        console.log(`\n  · ${block.name}(${JSON.stringify(block.input).slice(0, 140)})`);
      }
    }
  } else if (msg.type === "result") {
    console.log(`\n\n=== done ===`);
    if (msg.subtype === "success") {
      console.log(msg.result);
      console.log(`turns=${msg.num_turns}  cost=$${msg.total_cost_usd.toFixed(4)}`);
    } else {
      console.log(`result ended with: ${msg.subtype}`);
    }
  }
}

// --- 3. Persist the session id so Step 2 can resume this conversation ---
mkdirSync("sessions", { recursive: true });
const sessFile = join("sessions", `${name}.json`);
writeFileSync(sessFile, JSON.stringify({ repo, workdir, sessionId }, null, 2));
console.log(`\nsession id saved to ${sessFile}: ${sessionId}`);
if (prCandidate) console.log(`PR: ${prCandidate}`);
