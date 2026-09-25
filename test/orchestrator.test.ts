import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ChatAdapter, type ChatAdapterService, type InboundMessage, type OutboundEvent } from "../src/adapter/types.ts";
import { Orchestrator, OrchestratorLive } from "../src/core/orchestrator.ts";
import { Registry, type RegistryService, type Room } from "../src/core/registry-service.ts";
import { Workspace, type WatchHandlers, type WorkspaceService } from "../src/core/workspace.ts";

// ---------------------------------------------------------------------------
// Fakes — the whole point of the adapter seam: onboarding, commands, and the
// approval flow are tested with zero Matrix, zero k8s, zero opencode.
// ---------------------------------------------------------------------------

const recorded: Array<{ conversationId: string; event: OutboundEvent }> = [];
const rooms = new Map<string, Room>();
const calls = {
  provision: [] as Array<{ name: string; rules?: string }>,
  teardown: [] as string[],
  respond: [] as boolean[],
  sent: [] as string[],
  aborted: 0,
  redacted: 0,
};
let watchHandlers: WatchHandlers | undefined;

const fakeAdapter: ChatAdapterService = {
  capabilities: { markdown: false, maxMessageChars: 3000, canRedact: true, agentRules: "FAKE-CHANNEL-RULES" },
  start: () => Effect.void,
  send: (conversationId, event) =>
    Effect.sync(() => {
      recorded.push({ conversationId, event });
    }),
  redact: () =>
    Effect.sync(() => {
      calls.redacted++;
      return true;
    }),
  label: () => Effect.succeed("Test Room"),
  parseApprovalAnswer: (text: string) => /^(y|yes)\b/i.test(text),
};

const fakeRegistry: RegistryService = {
  get: (id) => rooms.get(id),
  create: (id) => {
    const r = { roomId: id, onboarding: "repo" as const, lastActivity: Date.now() } as Room;
    rooms.set(id, r);
    return r;
  },
  save: (r) => rooms.set(r.roomId, r),
  touch: () => {},
  idle: () => [],
  delete: (id) => rooms.delete(id),
};

// Failure toggles — flip these to drive the typed error paths end-to-end.
const failures = {
  provision: false as "provision-failed" | false,
  sendMessage: null as "message-send-failed" | null,
  usage: false as "usage-fetch-failed" | false,
};

const fakeWorkspace: WorkspaceService = {
  resourceName: (id) => `room-test-${id.replace(/[^a-z0-9]/gi, "")}`,
  serverUrl: (name) => `http://${name}`,
  provision: (name, _project, rules) =>
    failures.provision
      ? Effect.fail(failures.provision)
      : Effect.sync(() => {
          calls.provision.push({ name, rules });
          return "server-password";
        }),
  waitForRunning: () => Effect.void,
  readPodState: () => Effect.succeed("running"),
  teardown: (name) =>
    Effect.sync(() => {
      calls.teardown.push(name);
    }),
  serverPassword: () => Effect.succeed("server-password"),
  createSession: () => Effect.succeed("ses1"),
  probe: () => Effect.void,
  sendMessage: (_b, _p, _s, text) =>
    failures.sendMessage
      ? Effect.fail(failures.sendMessage)
      : Effect.sync(() => {
          calls.sent.push(text);
          return `did the thing: ${text}`;
        }),
  abort: () =>
    Effect.sync(() => {
      calls.aborted++;
    }),
  usage: () => (failures.usage ? Effect.fail(failures.usage) : Effect.succeed({ cost: 1.25 })),
  respondPermission: (_b, _p, _s, _pid, approved) =>
    Effect.sync(() => {
      calls.respond.push(approved);
    }),
  watch: (_b, _p, handlers) =>
    Effect.sync(() => {
      watchHandlers = handlers;
      return () => {};
    }),
};

const runtime = ManagedRuntime.make(
  Layer.provide(
    OrchestratorLive({ idleTeardownMs: 3600_000, sweepIntervalMs: 60_000 }),
    Layer.mergeAll(
      Layer.effect(ChatAdapter, Effect.succeed(fakeAdapter)),
      Layer.effect(Registry, Effect.succeed(fakeRegistry)),
      Layer.effect(Workspace, Effect.succeed(fakeWorkspace)),
    ),
  ),
);

test.after(() => runtime.dispose());

const orchestrator = await runtime.runPromise(
  Effect.gen(function* () {
    return yield* Orchestrator;
  }),
);

/** handleInbound is a context-free Effect — run it explicitly (awaiting the
 * Effect object itself would be a silent no-op). */
const run = (msg: InboundMessage) => Effect.runPromise(orchestrator.handleInbound(msg));

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("condition not met within timeout");
};

const reset = () => {
  recorded.length = 0;
  rooms.clear();
  calls.provision.length = 0;
  calls.teardown.length = 0;
  calls.respond.length = 0;
  calls.sent.length = 0;
  calls.aborted = 0;
  calls.redacted = 0;
  failures.provision = false;
  failures.sendMessage = null;
  failures.usage = false;
  watchHandlers = undefined;
};

/** Full onboarding flow for one conversation — needed because reset() clears
 * the fake registry; every test must set up its own room. */
const onboard = async (id = "!t1") => {
  await run({ conversationId: id, text: "lab3ss/coding-agent" });
  await run({ conversationId: id, text: "ghp_token1234567", messageId: "$m1" });
  await run({ conversationId: id, text: "anthropic/claude-sonnet-4.5" });
};

test("onboarding collects repo → token → model, then provisions the workspace", async () => {
  reset();
  await run({ conversationId: "!t1", text: "lab3ss/coding-agent" });
  assert.equal(rooms.get("!t1")?.onboarding, "token");
  assert.ok(recorded.some((r) => r.event.type === "info" && r.event.text.includes("GitHub PAT")));

  await run({ conversationId: "!t1", text: "ghp_token1234567", messageId: "$m1" });
  assert.equal(rooms.get("!t1")?.token, "ghp_token1234567");
  assert.equal(rooms.get("!t1")?.onboarding, "model");
  assert.equal(calls.redacted, 1); // PAT scrubbed via the adapter capability

  await run({ conversationId: "!t1", text: "anthropic/claude-sonnet-4.5" });
  assert.equal(rooms.get("!t1")?.model, "anthropic/claude-sonnet-4.5");
  assert.equal(rooms.get("!t1")?.podName, "room-test-t1");
  assert.equal(rooms.get("!t1")?.sessionId, "ses1");
  assert.equal(calls.provision.length, 1);
  // The channel's formatting capability profile is injected into the pod.
  assert.equal(calls.provision[0].rules, "FAKE-CHANNEL-RULES");
  const last = recorded[recorded.length - 1];
  assert.equal(last.event.type, "info");
  assert.ok(last.event.type === "info" && last.event.text.includes("Ready"));
});

test("steady-state task goes to opencode and the reply comes back as a result", async () => {
  reset();
  await onboard("!t2");
  await run({ conversationId: "!t2", text: "fix the login bug" });
  assert.deepEqual(calls.sent, ["fix the login bug"]);
  const result = recorded.find((r) => r.event.type === "result");
  assert.ok(result);
  assert.equal(result.event.type === "result" && result.event.text, "did the thing: fix the login bug");
});

test("permission request is asked in the room; 'yes' relays allow to opencode", async () => {
  reset();
  await onboard("!t3");
  watchHandlers!.onPermission({ sessionId: "ses1", permissionId: "p1", description: "git push" });
  await until(() => recorded.some((r) => r.event.type === "approval-request"));

  await run({ conversationId: "!t3", text: "yes" });
  assert.deepEqual(calls.respond, [true]);
  const decision = recorded.find((r) => r.event.type === "approval-result");
  assert.ok(decision);
  assert.equal(decision.event.type === "approval-result" && decision.event.approved, true);
});

test("'no' denies and is relayed as deny", async () => {
  reset();
  await onboard("!t4");
  watchHandlers!.onPermission({ sessionId: "ses1", permissionId: "p2", description: "rm -rf /" });
  await until(() => recorded.some((r) => r.event.type === "approval-request"));

  await run({ conversationId: "!t4", text: "absolutely not" });
  assert.deepEqual(calls.respond, [false]);
});

test("/stop works while an approval is pending and resolves it without POSTing", async () => {
  reset();
  await onboard("!t5");
  watchHandlers!.onPermission({ sessionId: "ses1", permissionId: "p3", description: "git push" });
  await until(() => recorded.some((r) => r.event.type === "approval-request"));

  await run({ conversationId: "!t5", text: "/stop" });
  assert.equal(calls.teardown.length, 1);
  assert.equal(calls.respond.length, 0); // answered (denied) locally, never POSTed to the dead pod
  assert.equal(rooms.get("!t5")?.podName, undefined);
  const td = recorded.find((r) => r.event.type === "teardown");
  assert.ok(td);
  assert.equal(td.event.type === "teardown" && td.event.reason, "requested");
});

test("abandoned conversation tears down the pod and purges the registry row", async () => {
  reset();
  await onboard("!t5b");
  assert.ok(rooms.has("!t5b"));

  await Effect.runPromise(orchestrator.abandon("!t5b"));
  assert.ok(!rooms.has("!t5b"));
  assert.equal(calls.teardown.length, 1);
  assert.equal(calls.teardown[0], "room-test-t5b");
  // No outbound event for this one — nobody is left in the conversation to read it.
  assert.equal(recorded.filter((r) => r.conversationId === "!t5b").at(-1)?.event.type, "info");
});

test("abandoning a conversation that never onboarded is a no-op", async () => {
  reset();
  await Effect.runPromise(orchestrator.abandon("!never-seen"));
  assert.equal(calls.teardown.length, 0);
});

test("/model updates per-message routing without touching the pod", async () => {
  reset();
  await onboard("!t6");
  await run({ conversationId: "!t6", text: "/model openai/gpt-5.2" });
  assert.equal(rooms.get("!t6")?.model, "openai/gpt-5.2");
  assert.equal(calls.provision.length, 1); // onboarding provisioned once; /model must not re-provision
  assert.ok(recorded.some((r) => r.event.type === "info" && r.event.text.includes("Model set to")));
});

test("broken input during onboarding re-asks instead of provisioning", async () => {
  reset();
  await run({ conversationId: "!t7", text: "fix the login bug please" });
  assert.equal(rooms.get("!t7")?.onboarding, "repo"); // no repo parsed, still asking
  assert.equal(calls.provision.length, 0);
});

test("onboarding provision failure surfaces the typed code in the room", async () => {
  reset();
  await run({ conversationId: "!t8", text: "lab3ss/coding-agent" });
  await run({ conversationId: "!t8", text: "ghp_token1234567", messageId: "$m1" });
  failures.provision = "provision-failed";
  await run({ conversationId: "!t8", text: "anthropic/claude-sonnet-4.5" });
  const err = recorded.find((r) => r.event.type === "error");
  assert.ok(err);
  assert.equal(err.event.type === "error" && err.event.text, "setup failed: provision-failed (details in broker logs)");
});

test("task failure surfaces the typed code and aborts the server-side turn", async () => {
  reset();
  await onboard("!t9");
  failures.sendMessage = "message-send-failed";
  await run({ conversationId: "!t9", text: "fix the login bug" });
  assert.equal(calls.aborted, 1); // turn aborted so it can't queue future messages
  const err = recorded.find((r) => r.event.type === "error");
  assert.ok(err);
  assert.equal(err.event.type === "error" && err.event.text, "task failed: message-send-failed (details in broker logs)");
});

test("/usage failure surfaces the typed code", async () => {
  reset();
  await onboard("!t10");
  failures.usage = "usage-fetch-failed";
  await run({ conversationId: "!t10", text: "/usage" });
  const err = recorded.find((r) => r.event.type === "error");
  assert.ok(err);
  assert.equal(err.event.type === "error" && err.event.text, "couldn't fetch usage: usage-fetch-failed (details in broker logs)");
});
