import { test } from "node:test";
import assert from "node:assert/strict";
import { roomResourceName } from "../src/k8s.ts";

test("roomResourceName is DNS-safe and <=63 chars", () => {
  const name = roomResourceName("! projeté très très long ".repeat(5) + "🔥");
  assert.match(name, /^[a-z0-9-]+$/);
  assert.ok(name.length <= 63);
  assert.ok(name.startsWith("room-"));
});

test("roomResourceName is stable per roomId", () => {
  assert.equal(roomResourceName("abc", "My Room"), roomResourceName("abc", "My Room"));
});

test("roomResourceName differs for different rooms sharing a display name", () => {
  assert.notEqual(roomResourceName("roomA", "dev"), roomResourceName("roomB", "dev"));
});

test("roomResourceName works with no room name", () => {
  const name = roomResourceName("xyz");
  assert.match(name, /^room-[0-9a-f]{16}$/);
});
