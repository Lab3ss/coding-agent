import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchEvent, type SseHandlers } from "../src/opencode.ts";

function recording(): SseHandlers & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {
    onPermission: [],
    onProgress: [],
    onSessionError: [],
    onCostUpdate: [],
    onCompacted: [],
  };
  return {
    calls,
    onPermission: (r) => calls.onPermission.push(r),
    onProgress: (p) => calls.onProgress.push(p),
    onSessionError: (e) => calls.onSessionError.push(e),
    onCostUpdate: (u) => calls.onCostUpdate.push(u),
    onCompacted: (s) => calls.onCompacted.push(s),
  };
}

test("permission event routes to onPermission", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "permission.updated",
      properties: { type: "permission.updated", sessionID: "ses1", permissionID: "p1", title: "git push" },
    },
    h,
  );
  assert.deepEqual(h.calls.onPermission, [{ sessionId: "ses1", permissionId: "p1", description: "git push" }]);
  assert.equal(h.calls.onProgress.length, 0);
});

test("tool-running event routes to onProgress", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "message.part.updated",
      properties: {
        part: { type: "tool", sessionID: "ses1", tool: "bash", state: { status: "running", title: "npm test" } },
      },
    },
    h,
  );
  assert.deepEqual(h.calls.onProgress, [{ sessionId: "ses1", title: "npm test" }]);
});

test("non-running tool states don't emit progress", () => {
  const h = recording();
  dispatchEvent(
    { type: "message.part.updated", properties: { part: { type: "tool", state: { status: "completed" } } } },
    h,
  );
  assert.equal(h.calls.onProgress.length, 0);
});

test("session error, cost update, and compaction route correctly", () => {
  const h = recording();
  dispatchEvent({ type: "session.error", properties: { sessionID: "ses1", error: { message: "boom" } } }, h);
  dispatchEvent(
    { type: "session.updated", properties: { sessionID: "ses1", info: { cost: 1.25 } } },
    h,
  );
  dispatchEvent({ type: "session.compacted", properties: { sessionID: "ses1" } }, h);
  assert.deepEqual(h.calls.onSessionError, [{ sessionId: "ses1", message: '{"message":"boom"}' }]);
  assert.deepEqual(h.calls.onCostUpdate, [{ sessionId: "ses1", cost: 1.25 }]);
  assert.deepEqual(h.calls.onCompacted, ["ses1"]);
});

test("absent cost is passed through as undefined, not crashed on", () => {
  const h = recording();
  dispatchEvent({ type: "session.updated", properties: { sessionID: "ses1", info: {} } }, h);
  assert.deepEqual(h.calls.onCostUpdate, [{ sessionId: "ses1", cost: undefined }]);
});

test("unknown/malformed events are ignored", () => {
  const h = recording();
  dispatchEvent({ type: "storage.write", properties: { key: "x" } }, h);
  dispatchEvent({}, h);
  assert.equal(
    h.calls.onPermission.length + h.calls.onProgress.length + h.calls.onSessionError.length +
      h.calls.onCostUpdate.length + h.calls.onCompacted.length,
    0,
  );
});
