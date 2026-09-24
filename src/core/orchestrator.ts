/**
 * Conversation orchestrator — the transport-neutral core of the broker.
 *
 * Owns everything chat-shaped-but-platform-agnostic: the onboarding state
 * machine, command routing, the busy-lock, the approval wait/resolve cycle,
 * cost alerting, idle teardown, and the provisioning/self-healing flow for a
 * conversation's workspace. Speaks only to three Effect services:
 *
 *   ChatAdapter  — outbound events + inbound message parsing (this file never
 *                  mentions Matrix)
 *   Registry     — persisted per-conversation state (repo/token/model/pod)
 *   Workspace    — k8s provisioning + the room's opencode server
 *
 * handleInbound never fails: every failure below it is already a typed,
 * string-literal code (see WorkspaceError), and any escape — even a defect
 * thrown by sync infra — becomes a room-visible error event, so one bad
 * message can't take the broker down. Room-visible texts carry the stable
 * code (e.g. "task failed: message-send-failed"); raw causes (HTTP status,
 * errno, stack) are logged exactly once, at the seam that produced them.
 */
import { Context, Effect, Layer } from "effect";
import { ChatAdapter, type InboundMessage, type OutboundEvent } from "../adapter/types.ts";
import { describeError, formatUsage, parseRepo } from "../util.ts";
import { Registry, type Room } from "./registry-service.ts";
import { Workspace, type WorkspaceError } from "./workspace.ts";

const COST_ALERT_STEP_USD = 5;

export type OrchestratorConfig = {
  /** Idle threshold before a live pod is torn down automatically. */
  readonly idleTeardownMs: number;
  /** How often the idle sweep runs. */
  readonly sweepIntervalMs: number;
};

export interface OrchestratorService {
  /** Handles one inbound user message. Error channel is `never`: every path
   * either succeeds or turns its typed code into a room-visible error event. */
  readonly handleInbound: (msg: InboundMessage) => Effect.Effect<void>;
  /** Starts background loops (idle sweep) and hooks the chat adapter's inbound
   * stream into handleInbound. Forks and returns immediately. Fails with a
   * stable code if the transport can't come up — boot should crash on it. */
  readonly start: Effect.Effect<void, "chat-start-failed">;
}

export class Orchestrator extends Context.Tag("coding-agent/Orchestrator")<Orchestrator, OrchestratorService>() {}

const make = (config: OrchestratorConfig) =>
  Effect.gen(function* () {
    const adapter = yield* ChatAdapter;
    const registry = yield* Registry;
    const workspace = yield* Workspace;

    // Live-pod-only per-conversation state, never persisted: the opencode
    // server password (fresh every provision), the SSE watcher's stop
    // function, the approval wait, the busy-lock, and cost-alert progress.
    const serverPasswords = new Map<string, string>();
    const permissionWatchers = new Map<string, () => void>();
    const pendingApprovals = new Map<string, (approved: boolean) => void>();
    const busyRooms = new Set<string>();
    const lastAlertedCostUsd = new Map<string, number>();

    /** Chat delivery is best-effort and must never abort core logic. */
    const send = (conversationId: string, event: OutboundEvent): Effect.Effect<void> => adapter.send(conversationId, event);

    const announce = (room: Room, text: string): Effect.Effect<void> => send(room.roomId, { type: "status", text });

    /** What the room sees when a typed code surfaces — the code is the
     * identified reason; the underlying cause lives in the broker logs. */
    const errorEvent = (code: WorkspaceError, prefix = "failed"): OutboundEvent => ({
      type: "error",
      text: `${prefix}: ${code} (details in broker logs)`,
    });

    function stopWatcher(conversationId: string): void {
      permissionWatchers.get(conversationId)?.();
      permissionWatchers.delete(conversationId);
      serverPasswords.delete(conversationId);
      lastAlertedCostUsd.delete(conversationId); // a re-provision starts a fresh $0 opencode session
      // If an approval was pending when the pod went away, nobody will ever POST
      // the response — resolve it (denied) so the wait doesn't dangle.
      pendingApprovals.get(conversationId)?.(false);
      pendingApprovals.delete(conversationId);
    }

    const startWatcher = (room: Room): Effect.Effect<void, "watch-failed"> =>
      Effect.gen(function* () {
        if (permissionWatchers.has(room.roomId)) return;
        const password = serverPasswords.get(room.roomId);
        if (!password) return;
        const baseUrl = workspace.serverUrl(room.podName!);

        const stop = yield* workspace.watch(baseUrl, password, {
          onPermission: (permReq) => {
            void Effect.runPromise(
              Effect.gen(function* () {
                yield* send(room.roomId, { type: "approval-request", description: permReq.description });
                const approved = yield* Effect.async<boolean>((resume) => {
                  pendingApprovals.set(room.roomId, (decision) => resume(Effect.succeed(decision)));
                });
                // The pod may have been torn down while the answer was pending
                // (stopWatcher resolved us with a denial and dropped the watcher) —
                // don't POST a permission response to a dead pod.
                if (!permissionWatchers.has(room.roomId)) return;
                yield* workspace.respondPermission(baseUrl, password, permReq.sessionId, permReq.permissionId, approved).pipe(
                  Effect.catchAll((code) => send(room.roomId, errorEvent(code, "failed to record approval"))),
                );
              }),
            ).catch((err) => console.warn(`[${room.roomId}] approval flow failed:`, describeError(err)));
          },
          onProgress: (progress) => {
            if (progress.sessionId !== room.sessionId) return;
            console.log(`[${room.roomId}] 🔧 ${progress.title}`);
            void Effect.runPromise(
              send(room.roomId, { type: "progress", title: progress.title }),
            ).catch((err) => console.warn(`[${room.roomId}] failed to send progress:`, describeError(err)));
          },
          onSessionError: (sessErr) => {
            if (sessErr.sessionId && sessErr.sessionId !== room.sessionId) return;
            console.warn(`[${room.roomId}] session error:`, sessErr.message);
            void Effect.runPromise(send(room.roomId, { type: "error", text: `session error: ${sessErr.message}` })).catch(
              () => {},
            );
          },
          onCostUpdate: (update) => {
            if (update.sessionId !== room.sessionId) return;
            // Some models/providers don't report cost at all — nothing to alert on then.
            if (typeof update.cost !== "number") return;
            try {
              const already = lastAlertedCostUsd.get(room.roomId) ?? 0;
              if (update.cost - already < COST_ALERT_STEP_USD) return;
              const step = Math.floor(update.cost / COST_ALERT_STEP_USD) * COST_ALERT_STEP_USD;
              lastAlertedCostUsd.set(room.roomId, step);
              void Effect.runPromise(send(room.roomId, { type: "cost-alert", stepUsd: step })).catch((err) =>
                console.warn(`[${room.roomId}] failed to send cost alert:`, describeError(err)),
              );
            } catch (err) {
              console.warn(`[${room.roomId}] cost alert check failed:`, describeError(err));
            }
          },
          onCompacted: (sessionId) => {
            if (sessionId !== room.sessionId) return;
            console.log(`[${room.roomId}] 🗜️ context compacted`);
            void Effect.runPromise(send(room.roomId, { type: "compacted" })).catch(() => {});
          },
          onError: (err) => console.warn(`[${room.roomId}] permission watcher error:`, describeError(err)),
        });
        permissionWatchers.set(room.roomId, stop);
      });

    /**
     * No-op if already provisioned; re-provisions (fresh session) if idle-torn-down.
     * If the pod is already live but the broker restarted since (losing its
     * in-memory serverPasswords/permissionWatchers), recovers the password from
     * the Secret and restarts the watcher rather than assuming they're set.
     *
     * Self-heals a stale registry row: if the recorded pod is actually gone or
     * dead (out-of-band deletion, node reboot, eviction, OOM-kill with
     * restartPolicy: Never), drops the leftovers and re-provisions — otherwise
     * every message would retry a black hole forever (the Secret still exists,
     * so password recovery "succeeds" into nothing).
     */
    /** Everything ensureProvisioned can fail with — callers switch on these codes. */
    type ProvisionError =
      | "pod-read-failed"
      | "provision-failed"
      | "pod-wait-failed"
      | "session-create-failed"
      | "secret-read-failed"
      | "watch-failed";

    const ensureProvisioned = (room: Room): Effect.Effect<void, ProvisionError> =>
      Effect.gen(function* () {
        if (room.podName) {
          // A pod-read failure is an API/rbac hiccup, not proof the pod is dead —
          // treat like the pending/unknown case and keep the recovery path.
          const state = yield* workspace
            .readPodState(room.podName)
            .pipe(Effect.catchAll(() => Effect.succeed("unknown" as const)));
          if (state === "gone" || state === "failed") {
            yield* announce(room, "♻️ previous workspace pod is gone — re-provisioning…");
            yield* workspace.teardown(room.podName).pipe(
              Effect.catchAll((code) =>
                Effect.sync(() => console.warn(`[${room.roomId}] stale pod cleanup failed: ${code}`)),
              ),
            );
            room.podName = undefined;
            room.sessionId = undefined;
            registry.save(room);
            stopWatcher(room.roomId);
          } else {
            if (!serverPasswords.has(room.roomId)) {
              serverPasswords.set(room.roomId, yield* workspace.serverPassword(room.podName));
            }
            yield* startWatcher(room);
            return;
          }
        }
        const label = yield* adapter.label(room.roomId);
        const name = workspace.resourceName(room.roomId, label);
        yield* announce(room, "📦 creating pod…");
        const password = yield* workspace.provision(name, { repo: room.repo!, token: room.token! }, adapter.capabilities.agentRules);
        serverPasswords.set(room.roomId, password);
        yield* announce(room, "⏳ waiting for pod to start (cloning repo)…");
        yield* workspace.waitForRunning(name);
        yield* announce(room, "🔌 pod running, connecting to opencode server…");
        const sessionId = yield* workspace.createSession(workspace.serverUrl(name), password);
        room.podName = name;
        room.sessionId = sessionId;
        registry.save(room);
        yield* startWatcher(room);
      });

    function teardownFields(room: Room): void {
      room.podName = undefined;
      room.sessionId = undefined;
      registry.save(room);
    }

    /** Total: a failed k8s delete must never block the room's teardown — the
     * cause is logged at the seam ("teardown-failed"). */
    const teardown = (room: Room, reason: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        stopWatcher(room.roomId);
        if (room.podName) {
          yield* workspace.teardown(room.podName).pipe(Effect.catchAll(() => Effect.void));
        }
        teardownFields(room);
        yield* send(room.roomId, { type: "teardown", reason, repo: room.repo ?? "" });
      });

    /** Live usage pull, not the cached SSE state — always accurate, and works even
     * before any session.updated event has arrived. */
    const sendUsage = (room: Room): Effect.Effect<void, "usage-fetch-failed" | "secret-read-failed"> =>
      Effect.gen(function* () {
        const password = serverPasswords.get(room.roomId) ?? (yield* workspace.serverPassword(room.podName!));
        const usage = yield* workspace.usage(workspace.serverUrl(room.podName!), password, room.sessionId!);
        yield* send(room.roomId, { type: "usage", text: formatUsage(usage) });
      });

    /** The steady-state turn: provision (transparently), probe, send, relay — and
     * abort server-side when we give up, so the turn can't silently queue the
     * next one behind a dead request. */
    const runTask = (room: Room, body: string): Effect.Effect<void> => {
      let sentAt = 0;
      return Effect.gen(function* () {
        yield* ensureProvisioned(room); // transparently re-provisions if idle-torn-down
        yield* announce(room, "🛠️ on it…");
        const password = serverPasswords.get(room.roomId)!;
        const baseUrl = workspace.serverUrl(room.podName!);
        // Catches a wedged connection (same class of bug as the provisioning-time one) before
        // committing to sendMessage's up-to-30-minute call, where it would otherwise be
        // indistinguishable from a genuinely long turn.
        yield* workspace.probe(baseUrl, password);
        sentAt = Date.now();
        const reply = yield* workspace.sendMessage(baseUrl, password, room.sessionId!, body, room.model);
        yield* send(room.roomId, { type: "result", text: reply || "(no output)" });
      }).pipe(
        Effect.catchAll((code) =>
          Effect.gen(function* () {
            // Only console.log's own line has a timestamp (via `kubectl logs --timestamps`) and
            // survives independently of Matrix — the error text sent to the room can get lost in
            // scrollback. Logging the code + elapsed time here is what lets a future 30-min turn
            // timeout be told apart from a genuine long task cut short vs. a stall: cross-reference
            // against the last "🔧 ..." progress line for this room to see whether opencode was
            // still actively working right up to the cutoff, or had gone silent well before it.
            console.error(`[${room.roomId}] task failed after ${Date.now() - sentAt}ms: ${code}`);
            // Without this, opencode has no idea the core gave up — the turn keeps running
            // server-side, and since a session handles one turn at a time, every future message
            // on this session queues silently behind it forever instead of erroring. Best-effort:
            // a failure here shouldn't hide the original error from the user.
            if (room.podName && room.sessionId) {
              yield* workspace
                .abort(workspace.serverUrl(room.podName), serverPasswords.get(room.roomId)!, room.sessionId)
                .pipe(
                  Effect.catchAll((abortCode) =>
                    Effect.sync(() => console.warn(`[${room.roomId}] session abort failed: ${abortCode}`)),
                  ),
                );
            }
            yield* send(room.roomId, errorEvent(code, "task failed"));
          }),
        ),
      );
    };

    const handleOnboardingModel = (room: Room): Effect.Effect<void> =>
      Effect.gen(function* () {
        busyRooms.add(room.roomId);
        yield* announce(room, `Setting up ${room.repo}…`);
        yield* ensureProvisioned(room);
        yield* send(room.roomId, { type: "info", text: "✅ Ready. What would you like me to do?" });
      }).pipe(
        Effect.catchAll((code) => send(room.roomId, errorEvent(code, "setup failed"))),
        Effect.ensuring(Effect.sync(() => busyRooms.delete(room.roomId))),
      );

    const handleInbound = (msg: InboundMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        const roomId = msg.conversationId;
        const body = msg.text.trim();
        registry.touch(roomId);

        // Slash-style commands first: they must work even while an approval is
        // pending (e.g. /stop during an approval prompt must not get swallowed
        // and answered as "denied"). The syntax itself stays with the adapter
        // (via msg.text); the command set lives here.
        if (/^\/stop\b/i.test(body)) {
          const room = registry.get(roomId);
          if (!room?.podName) {
            yield* send(roomId, { type: "info", text: "Nothing running here." });
            return;
          }
          yield* sendUsage(room).pipe(
            Effect.catchAll((code) => Effect.sync(() => console.warn(`[${roomId}] usage fetch on stop failed: ${code}`))),
          );
          yield* teardown(room, "requested");
          return;
        }

        if (/^\/usage\b/i.test(body)) {
          const room = registry.get(roomId);
          if (!room?.podName) {
            yield* send(roomId, {
              type: "info",
              text: "Nothing running here yet — send a message first to provision the workspace.",
            });
            return;
          }
          yield* sendUsage(room).pipe(
            Effect.catchAll((code) => send(roomId, errorEvent(code, "couldn't fetch usage"))),
          );
          return;
        }

        if (/^\/connect\b/i.test(body)) {
          const room = registry.get(roomId);
          if (!room?.podName) {
            yield* send(roomId, {
              type: "info",
              text: "Nothing running here yet — send a message first to provision the workspace.",
            });
            return;
          }
          const cached = serverPasswords.get(roomId);
          const password = cached ?? (yield* workspace.serverPassword(room.podName).pipe(
            Effect.catchAll((code) =>
              send(roomId, errorEvent(code, "couldn't read the server password")).pipe(Effect.as(undefined)),
            ),
          ));
          if (!password) return;
          serverPasswords.set(roomId, password);
          yield* send(
            roomId,
            {
              type: "info",
              text:
                "VPN/cluster access only — this never leaves the private network. From a machine with " +
                `kubectl access:\n\nkubectl port-forward -n coding-agent-rooms svc/${room.podName} 4096:4096\n` +
                `opencode attach http://localhost:4096 -p ${password}\n\n` +
                "Keep the port-forward running in one terminal, attach in another. Works alongside chatting " +
                "here — alternate freely, same session either way.",
            },
          );
          return;
        }

        if (/^\/model\b/i.test(body)) {
          const room = registry.get(roomId);
          const arg = body.replace(/^\/model\s*/i, "").trim();
          if (!arg) {
            yield* send(roomId, {
              type: "info",
              text: room?.model ? `Current model: ${room.model}` : "No model set yet.",
            });
            return;
          }
          if (!room) {
            yield* send(roomId, { type: "info", text: "No project set up in this room yet — send a repo first." });
            return;
          }
          room.model = arg;
          registry.save(room);
          // model is sent per-message (src/opencode.ts), never baked into the pod,
          // so this takes effect on the very next message — no restart needed.
          yield* send(roomId, { type: "info", text: `Model set to ${arg}. Takes effect on your next message.` });
          return;
        }

        // If this room is waiting on an approval, this message IS the answer.
        const pending = pendingApprovals.get(roomId);
        if (pending) {
          pendingApprovals.delete(roomId);
          const approved = adapter.parseApprovalAnswer(body);
          yield* send(roomId, { type: "approval-result", approved });
          pending(approved);
          return;
        }

        if (busyRooms.has(roomId)) {
          yield* send(roomId, { type: "info", text: "Still working on the previous request — one moment." });
          return;
        }

        const room = registry.get(roomId) ?? registry.create(roomId);

        if (room.onboarding === "repo") {
          const repo = parseRepo(body);
          if (!repo) {
            yield* send(roomId, {
              type: "info",
              text: "What repo should I work on? Reply with `owner/name` or a GitHub URL.",
            });
            return;
          }
          room.repo = repo;
          room.onboarding = "token";
          registry.save(room);
          yield* send(roomId, {
            type: "info",
            text: `Got it: ${repo}. Now send a GitHub PAT scoped to that repo — it's used only inside this conversation's isolated workspace, never shared with any other room.`,
          });
          return;
        }

        if (room.onboarding === "token") {
          if (body.length < 10) {
            yield* send(roomId, { type: "info", text: "That doesn't look like a token — send the GitHub PAT for this room." });
            return;
          }
          room.token = body;
          room.onboarding = "model";
          registry.save(room);
          // Best-effort: strip the PAT out of chat history right after reading it.
          // Not a security boundary (the platform may retain it briefly, and
          // deletion can't reach anywhere the message already federated), just
          // closes the main practical exposure — nobody scrolling back sees it.
          // The adapter reports honestly whether it managed (e.g. Matrix
          // redaction needs moderator power level).
          const redacted = msg.messageId && adapter.capabilities.canRedact ? yield* adapter.redact(roomId, msg.messageId) : false;
          yield* send(roomId, { type: "token-received", redacted });
          return;
        }

        if (room.onboarding === "model") {
          room.model = body;
          room.onboarding = undefined;
          registry.save(room);
          yield* handleOnboardingModel(room);
          return;
        }

        // Steady state: repo/token/model all known.
        busyRooms.add(room.roomId);
        yield* runTask(room, body).pipe(Effect.ensuring(Effect.sync(() => busyRooms.delete(room.roomId))));
      }).pipe(
        // Error boundary, total by construction: every workspace failure above
        // is already a typed code caught at its call site, so catchAll only
        // fires for genuinely unexpected paths (its `code` is statically
        // `never` here) — and catchDefect even converts a defect thrown by
        // sync infra (e.g. SQLite) into a room-visible event instead of an
        // unhandled rejection. One bad message can never take the broker down.
        Effect.catchAll((code) => send(msg.conversationId, errorEvent(code))),
        Effect.catchAllDefect((defect) =>
          Effect.gen(function* () {
            console.error(`[${msg.conversationId}] internal-defect:`, describeError(defect));
            yield* send(msg.conversationId, { type: "error", text: "internal-defect (details in broker logs)" });
          }),
        ),
      );

    const sweep: Effect.Effect<void> =
      Effect.forEach(registry.idle(config.idleTeardownMs), (room) =>
        Effect.gen(function* () {
          console.log(`[${room.roomId}] idle >${(config.idleTeardownMs / 3600_000).toFixed(1)}h — tearing down`);
          yield* teardown(room, "idle"); // total — k8s delete failures are logged at the seam
        }),
      );

    const start: Effect.Effect<void, "chat-start-failed"> =
      Effect.gen(function* () {
        const sweepLoop = Effect.forever(Effect.andThen(Effect.sleep(config.sweepIntervalMs), sweep));
        yield* Effect.forkDaemon(sweepLoop);
        // Wire the transport's inbound stream to the core. handleInbound is a
        // closure over concrete services (no Effect context), so it runs via
        // plain runPromise here — no runtime plumbing needed. The catch is
        // belt-and-suspenders: handleInbound's own boundary is total.
        yield* adapter.start((msg) => {
          void Effect.runPromise(handleInbound(msg)).catch((err) =>
            console.error(`[${msg.conversationId}] orchestrator failure:`, describeError(err)),
          );
        });
      });

    return { handleInbound, start } satisfies OrchestratorService;
  });

export const OrchestratorLive = (config: OrchestratorConfig) => Layer.effect(Orchestrator, make(config));
