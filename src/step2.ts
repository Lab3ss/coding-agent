/**
 * Step 2 — prove session resume / multi-turn.
 *
 * Loads the session_id saved by Step 1 and sends a FOLLOW-UP instruction with
 * `resume`. The follow-up deliberately refers to "the PR you just opened" without
 * restating any details — if the agent names the right branch/PR from memory and
 * adds to the same one, conversation persistence works. This is the foundation
 * for "one Matrix room = one ongoing session".
 *
 * Run:  node src/step2.ts [name]      (name defaults to broker-sandbox)
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2] ?? "broker-sandbox";
const sessFile = join("sessions", `${name}.json`);
const sess = JSON.parse(readFileSync(sessFile, "utf8")) as {
  repo: string;
  workdir: string;
  sessionId: string;
};

if (!sess.sessionId) throw new Error(`No sessionId in ${sessFile} — run Step 1 first.`);
console.log(`Resuming session ${sess.sessionId} for ${sess.repo}\n`);

const followUp = `Follow-up to the pull request you just opened:

Create a CHANGELOG.md (or append if it exists) with a single entry that summarizes
the exact change you made in that PR. Commit it to the SAME branch you created
earlier and push, so the existing pull request picks it up — do not open a new PR.

Before you start, tell me from memory: which branch are you on, and what was the
PR URL? Then make the change.`;

let sessionId = sess.sessionId;

for await (const msg of query({
  prompt: followUp,
  options: {
    cwd: sess.workdir,
    resume: sess.sessionId, // <-- the whole point of Step 2
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    maxTurns: 40,
    stderr: (d) => process.stderr.write(d),
  },
})) {
  sessionId = (msg as any).session_id ?? sessionId;

  if (msg.type === "system" && msg.subtype === "init") {
    console.log(`[resumed session ${msg.session_id}] model=${msg.model}\n`);
  } else if (msg.type === "assistant") {
    for (const block of msg.message.content as any[]) {
      if (block.type === "text") process.stdout.write(block.text);
      else if (block.type === "tool_use")
        console.log(`\n  · ${block.name}(${JSON.stringify(block.input).slice(0, 140)})`);
    }
  } else if (msg.type === "result") {
    console.log(`\n\n=== done ===`);
    if (msg.subtype === "success") {
      console.log(`turns=${msg.num_turns}  cost=$${msg.total_cost_usd.toFixed(4)}`);
    } else {
      console.log(`result ended with: ${msg.subtype}`);
    }
  }
}

// Persist (the id is stable across resume unless forkSession is used).
writeFileSync(sessFile, JSON.stringify({ ...sess, sessionId }, null, 2));
console.log(`\nsession id (still): ${sessionId}`);
