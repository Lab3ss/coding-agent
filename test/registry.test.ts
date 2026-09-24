import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The registry opens its SQLite file at import time — point it at a throwaway
// file before importing. node --test runs each test file in its own process,
// so this env var can't leak into other suites.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-")), "registry.db");
process.env.REGISTRY_DB_PATH = dbPath;

const { newRoom, getRoom, saveRoom, touch, idleRooms } = await import("../src/registry.ts");
const { DatabaseSync } = await import("node:sqlite");

test("newRoom starts onboarding at the repo step and persists", () => {
  const r = newRoom("!r1:example.org");
  assert.equal(r.onboarding, "repo");
  assert.equal(getRoom("!r1:example.org")?.onboarding, "repo");
});

test("saveRoom persists the full row (what a broker restart relies on)", () => {
  const r = getRoom("!r1:example.org")!;
  r.repo = "lab3ss/coding-agent";
  r.token = "ghp_testtoken123456";
  r.model = "anthropic/claude-sonnet-4.5";
  r.podName = "room-dev-abc";
  r.sessionId = "ses_123";
  saveRoom(r);

  // Read back through a fresh SQLite handle, i.e. what a restarted broker's
  // registry import would load.
  const db = new DatabaseSync(dbPath);
  const row: any = db.prepare(`SELECT * FROM rooms WHERE room_id = ?`).get("!r1:example.org");
  db.close();
  assert.equal(row.repo, "lab3ss/coding-agent");
  assert.equal(row.token, "ghp_testtoken123456");
  assert.equal(row.model, "anthropic/claude-sonnet-4.5");
  assert.equal(row.pod_name, "room-dev-abc");
  assert.equal(row.session_id, "ses_123");
});

test("touch bumps lastActivity and idleRooms respects it", async () => {
  const r = getRoom("!r1:example.org")!;
  r.lastActivity = Date.now() - 10 * 3600_000;
  saveRoom(r);
  assert.deepEqual(idleRooms(24 * 3600_000), []);
  assert.ok(idleRooms(9 * 3600_000).some((x) => x.roomId === "!r1:example.org"));
  touch("!r1:example.org");
  assert.deepEqual(idleRooms(9 * 3600_000), []);
});

test("idleRooms only considers rooms with a live pod", () => {
  const r = getRoom("!r1:example.org")!;
  r.podName = undefined;
  saveRoom(r);
  assert.deepEqual(idleRooms(0), []);
});
