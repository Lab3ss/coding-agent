/**
 * The workspace/infra domain (per-room k8s resources + the room's opencode
 * server) behind an Effect service. Wraps the promise/sync modules
 * (src/k8s.ts, src/opencode.ts) at this seam — everything below stays plain
 * TypeScript; everything above (orchestrator) speaks Effect.
 *
 * Error discipline: every method's error channel is a string-literal union —
 * one stable code per failure mode, so callers switch on exact causes. The
 * raw cause (HTTP status, errno, stack) is logged at this seam once and
 * never travels further; downstream code and the room only ever see the
 * identified code. Nothing throws across this boundary.
 *
 * The LLM credential (OPENROUTER_API_KEY) is infra-side: the orchestrator
 * never sees it, it's injected here at wiring time and copied into each
 * room's Secret at provision time.
 */
import { Context, Effect, Layer } from "effect";
import * as k8s from "../k8s.ts";
import * as opencode from "../opencode.ts";
import { describeError } from "../util.ts";

export type { RoomPodState, RoomEnv } from "../k8s.ts";
export type { SessionUsage, PermissionRequest, ToolProgress, SessionError, SessionCostUpdate } from "../opencode.ts";

/** Stable failure codes for the workspace seam. Raw causes are logged where
 * they happen (see `failing`), never propagated. */
export type WorkspaceError =
  | "provision-failed" // k8s create of Secret/Pod/Service failed (non-conflict)
  | "pod-wait-failed" // pod didn't reach Running (timeout, ImagePullBackOff, Failed phase…)
  | "pod-read-failed" // the pod GET itself failed (API/rbac/network — not 404, which is a state)
  | "teardown-failed" // deleting Pod/Service/Secret failed on something non-404
  | "secret-read-failed" // couldn't read back the room's server password
  | "session-create-failed" // opencode POST /session kept failing
  | "probe-failed" // connectivity probe kept failing (wedged connection)
  | "message-send-failed" // opencode rejected/lost the prompt turn
  | "session-abort-failed" // couldn't stop a turn the core gave up on
  | "usage-fetch-failed" // GET /session/:id failed
  | "permission-respond-failed" // POSTing an approval decision failed
  | "watch-failed"; // SSE event stream couldn't be opened

/** Callbacks out of the room's SSE event stream (runs outside Effect land). */
export type WatchHandlers = {
  onPermission: (req: opencode.PermissionRequest) => void;
  onProgress: (progress: opencode.ToolProgress) => void;
  onSessionError: (err: opencode.SessionError) => void;
  onCostUpdate: (update: opencode.SessionCostUpdate) => void;
  onCompacted: (sessionId: string) => void;
  onError: (err: unknown) => void;
};

export interface WorkspaceService {
  /** DNS-safe pod/secret/service name for a conversation (label is cosmetic). */
  readonly resourceName: (conversationId: string, label?: string) => string;
  /** In-cluster base URL of the room's opencode server. */
  readonly serverUrl: (resourceName: string) => string;
  /** Idempotent provision (Secret+Pod+Service); resolves to the server password. */
  readonly provision: (
    resourceName: string,
    project: { repo: string; token: string },
    agentRules?: string,
  ) => Effect.Effect<string, "provision-failed" | "secret-read-failed">;
  readonly waitForRunning: (resourceName: string) => Effect.Effect<void, "pod-wait-failed">;
  readonly readPodState: (resourceName: string) => Effect.Effect<k8s.RoomPodState, "pod-read-failed">;
  readonly teardown: (resourceName: string) => Effect.Effect<void, "teardown-failed">;
  /** Reads the room's opencode server password from its live Secret. */
  readonly serverPassword: (resourceName: string) => Effect.Effect<string, "secret-read-failed">;
  /** Creates the opencode session, retrying until the HTTP server is listening. */
  readonly createSession: (baseUrl: string, password: string) => Effect.Effect<string, "session-create-failed">;
  /** Bounded connectivity probe, retried — fails fast on a wedged connection. */
  readonly probe: (baseUrl: string, password: string) => Effect.Effect<void, "probe-failed">;
  readonly sendMessage: (
    baseUrl: string,
    password: string,
    sessionId: string,
    text: string,
    model?: string,
  ) => Effect.Effect<string, "message-send-failed">;
  /** Stops a turn that the core gave up on, so it can't queue future ones. */
  readonly abort: (baseUrl: string, password: string, sessionId: string) => Effect.Effect<void, "session-abort-failed">;
  readonly usage: (
    baseUrl: string,
    password: string,
    sessionId: string,
  ) => Effect.Effect<opencode.SessionUsage, "usage-fetch-failed">;
  readonly respondPermission: (
    baseUrl: string,
    password: string,
    sessionId: string,
    permissionId: string,
    approved: boolean,
  ) => Effect.Effect<void, "permission-respond-failed">;
  /** Opens the SSE stream; resolves to a stop function. Handlers run detached. */
  readonly watch: (
    baseUrl: string,
    password: string,
    handlers: WatchHandlers,
  ) => Effect.Effect<() => void, "watch-failed">;
}

export class Workspace extends Context.Tag("coding-agent/Workspace")<Workspace, WorkspaceService>() {}

/**
 * The container is Running before opencode's HTTP server inside it is actually listening.
 * Each attempt gets its own short-lived connection (callers pass a short AbortSignal timeout)
 * so a single wedged TCP handshake (e.g. a stale conntrack entry) can't stall the whole retry
 * loop — logged so `kubectl logs` shows why it's still "connecting" instead of nothing at all.
 */
function retryUntilReady<T>(fn: () => Promise<T>, attempts = 10, delayMs = 2000): Promise<T> {
  let lastErr: unknown;
  return (async () => {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        console.warn(`[retryUntilReady] attempt ${i + 1}/${attempts} failed: ${err?.message ?? err}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  })();
}

/** Wraps a promise call into an Effect whose failure is exactly `code`. The
 * raw cause is logged here — once, with full detail (code, message, cause
 * chain) — so the string union stays diagnosable without carrying payloads. */
const failing = <A, E extends WorkspaceError>(code: E, run: () => Promise<A>): Effect.Effect<A, E> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      console.error(`[workspace] ${code}: ${describeError(cause)}`);
      return code;
    },
  });

const makeWorkspace = (config: { openrouterKey: string }): WorkspaceService => ({
  resourceName: k8s.roomResourceName,
  serverUrl: k8s.roomServerUrl,

  provision: (name, project, agentRules) =>
    failing("provision-failed", () =>
      k8s.provisionRoom(name, { repo: project.repo, token: project.token, openrouterKey: config.openrouterKey }, agentRules),
    ),
  waitForRunning: (name) => failing("pod-wait-failed", () => k8s.waitForRunning(name)),
  readPodState: (name) => failing("pod-read-failed", () => k8s.readRoomPodState(name)),
  teardown: (name) => failing("teardown-failed", () => k8s.teardownRoom(name)),
  serverPassword: (name) => failing("secret-read-failed", () => k8s.getRoomServerPassword(name)),

  createSession: (baseUrl, password) =>
    failing("session-create-failed", () =>
      retryUntilReady(() => opencode.createSession(baseUrl, password, AbortSignal.timeout(10_000))),
    ),
  probe: (baseUrl, password) => failing("probe-failed", () => retryUntilReady(() => opencode.probeConnection(baseUrl, password))),
  sendMessage: (baseUrl, password, sessionId, text, model) =>
    failing("message-send-failed", () => opencode.sendMessage(baseUrl, password, sessionId, text, model)),
  abort: (baseUrl, password, sessionId) => failing("session-abort-failed", () => opencode.abortSession(baseUrl, password, sessionId)),
  usage: (baseUrl, password, sessionId) => failing("usage-fetch-failed", () => opencode.getSessionUsage(baseUrl, password, sessionId)),
  respondPermission: (baseUrl, password, sessionId, permissionId, approved) =>
    failing("permission-respond-failed", () => opencode.respondPermission(baseUrl, password, sessionId, permissionId, approved)),
  watch: (baseUrl, password, handlers) =>
    failing("watch-failed", () =>
      opencode.watchPermissions(
        baseUrl,
        password,
        handlers.onPermission,
        handlers.onProgress,
        handlers.onSessionError,
        handlers.onCostUpdate,
        handlers.onCompacted,
        handlers.onError,
      ),
    ),
});

export const WorkspaceLive = (config: { openrouterKey: string }) =>
  Layer.effect(Workspace, Effect.sync(() => makeWorkspace(config)));
