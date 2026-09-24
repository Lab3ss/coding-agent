/**
 * The workspace/infra domain (per-room k8s resources + the room's opencode
 * server) behind an Effect service. Wraps the promise/sync modules
 * (src/k8s.ts, src/opencode.ts) at this seam — everything below stays plain
 * TypeScript; everything above (orchestrator) speaks Effect.
 *
 * The LLM credential (OPENROUTER_API_KEY) is infra-side: the orchestrator
 * never sees it, it's injected here at wiring time and copied into each
 * room's Secret at provision time.
 */
import { Context, Effect, Layer } from "effect";
import * as k8s from "../k8s.ts";
import * as opencode from "../opencode.ts";

export type { RoomPodState, RoomEnv } from "../k8s.ts";
export type { SessionUsage, PermissionRequest, ToolProgress, SessionError, SessionCostUpdate } from "../opencode.ts";

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
  ) => Effect.Effect<string, unknown>;
  readonly waitForRunning: (resourceName: string) => Effect.Effect<void, unknown>;
  readonly readPodState: (resourceName: string) => Effect.Effect<k8s.RoomPodState, unknown>;
  readonly teardown: (resourceName: string) => Effect.Effect<void, unknown>;
  /** Reads the room's opencode server password from its live Secret. */
  readonly serverPassword: (resourceName: string) => Effect.Effect<string, unknown>;
  /** Creates the opencode session, retrying until the HTTP server is listening. */
  readonly createSession: (baseUrl: string, password: string) => Effect.Effect<string, unknown>;
  /** Bounded connectivity probe, retried — fails fast on a wedged connection. */
  readonly probe: (baseUrl: string, password: string) => Effect.Effect<void, unknown>;
  readonly sendMessage: (
    baseUrl: string,
    password: string,
    sessionId: string,
    text: string,
    model?: string,
  ) => Effect.Effect<string, unknown>;
  /** Stops a turn that the core gave up on, so it can't queue future ones. */
  readonly abort: (baseUrl: string, password: string, sessionId: string) => Effect.Effect<void, unknown>;
  readonly usage: (
    baseUrl: string,
    password: string,
    sessionId: string,
  ) => Effect.Effect<opencode.SessionUsage, unknown>;
  readonly respondPermission: (
    baseUrl: string,
    password: string,
    sessionId: string,
    permissionId: string,
    approved: boolean,
  ) => Effect.Effect<void, unknown>;
  /** Opens the SSE stream; resolves to a stop function. Handlers run detached. */
  readonly watch: (baseUrl: string, password: string, handlers: WatchHandlers) => Effect.Effect<() => void, unknown>;
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

const makeWorkspace = (config: { openrouterKey: string }): WorkspaceService => ({
  resourceName: k8s.roomResourceName,
  serverUrl: k8s.roomServerUrl,

  provision: (name, project, agentRules) =>
    Effect.tryPromise(() =>
      k8s.provisionRoom(name, { repo: project.repo, token: project.token, openrouterKey: config.openrouterKey }, agentRules),
    ),
  waitForRunning: (name) => Effect.tryPromise(() => k8s.waitForRunning(name)),
  readPodState: (name) => Effect.tryPromise(() => k8s.readRoomPodState(name)),
  teardown: (name) => Effect.tryPromise(() => k8s.teardownRoom(name)),
  serverPassword: (name) => Effect.tryPromise(() => k8s.getRoomServerPassword(name)),

  createSession: (baseUrl, password) =>
    Effect.tryPromise(() => retryUntilReady(() => opencode.createSession(baseUrl, password, AbortSignal.timeout(10_000)))),
  probe: (baseUrl, password) => Effect.tryPromise(() => retryUntilReady(() => opencode.probeConnection(baseUrl, password))),
  sendMessage: (baseUrl, password, sessionId, text, model) =>
    Effect.tryPromise(() => opencode.sendMessage(baseUrl, password, sessionId, text, model)),
  abort: (baseUrl, password, sessionId) => Effect.tryPromise(() => opencode.abortSession(baseUrl, password, sessionId)),
  usage: (baseUrl, password, sessionId) => Effect.tryPromise(() => opencode.getSessionUsage(baseUrl, password, sessionId)),
  respondPermission: (baseUrl, password, sessionId, permissionId, approved) =>
    Effect.tryPromise(() => opencode.respondPermission(baseUrl, password, sessionId, permissionId, approved)),
  watch: (baseUrl, password, handlers) =>
    Effect.tryPromise(() =>
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
