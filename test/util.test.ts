import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepo, describeError, formatUsage, splitForMatrix } from "../src/util.ts";

test("parseRepo accepts owner/name", () => {
  assert.equal(parseRepo("lab3ss/coding-agent"), "lab3ss/coding-agent");
  assert.equal(parseRepo("  Lab3ss/K8s-GitOps "), "Lab3ss/K8s-GitOps");
});

test("parseRepo accepts GitHub URLs and normalizes to owner/name", () => {
  assert.equal(parseRepo("https://github.com/lab3ss/coding-agent"), "lab3ss/coding-agent");
  assert.equal(parseRepo("https://github.com/lab3ss/coding-agent.git"), "lab3ss/coding-agent");
  assert.equal(parseRepo("git@github.com:lab3ss/coding-agent.git"), "lab3ss/coding-agent");
  assert.equal(parseRepo("clone https://github.com/lab3ss/coding-agent/tree/main please"), "lab3ss/coding-agent");
  assert.equal(parseRepo("work on https://github.com/lab3ss/coding-agent."), "lab3ss/coding-agent");
  assert.equal(parseRepo("(see https://github.com/lab3ss/coding-agent)"), "lab3ss/coding-agent");
});

test("parseRepo rejects non-repo text", () => {
  assert.equal(parseRepo("fix the login bug"), null);
  assert.equal(parseRepo("a/b/c"), null);
  assert.equal(parseRepo(""), null);
});

test("describeError unwraps undici's cause chain", () => {
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  });
  assert.equal(describeError(err), "connect timeout (code=UND_ERR_CONNECT_TIMEOUT)");
});

test("describeError falls back to String() for non-errors", () => {
  assert.equal(describeError("boom"), "boom");
});

test("formatUsage renders cost when reported", () => {
  const s = formatUsage({
    cost: 1.23456,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 5 } },
  });
  assert.match(s, /\$1\.2346/);
  assert.match(s, /in: 10 · out: 20/);
});

test("formatUsage says n/a when the model doesn't report cost", () => {
  assert.match(formatUsage({}), /n\/a/);
});

test("splitForMatrix keeps short text intact", () => {
  assert.deepEqual(splitForMatrix("hello"), ["hello"]);
});

test("splitForMatrix splits on line boundaries and preserves content", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");
  const parts = splitForMatrix(text, 1000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join("\n").replace(/\n{2,}/g, "\n"), text);
});

test("splitForMatrix hard-splits content with no line boundaries", () => {
  const text = "a".repeat(2500);
  const parts = splitForMatrix(text, 1000);
  assert.equal(parts.join(""), text);
  assert.ok(parts.length >= 3);
});
