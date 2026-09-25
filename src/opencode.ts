/**
 * HTTP client for one room's `opencode serve` instance (see runner/entrypoint.sh).
 * Basic-auth protected with a per-room random password (see src/k8s.ts) so
 * nothing else in the coding-agent-rooms namespace can reach another room's
 * server even over the cluster network.
 */
import { Agent, fetch as undiciFetch } from "undici";

// Node's *global* fetch defaults to a 5-minute socket timeout (undici's
// Agent default headersTimeout/bodyTimeout), which a real multi-step coding
// task (many tool calls, edits, test runs on /session/:id/message, a single
// blocking request for the whole turn) can easily exceed. A custom Agent
// can't be passed as `dispatcher` to the *global* fetch, though — Node's
// built-in fetch validates it against its own internal undici instance, and
// an Agent constructed from the separately-installed `undici` npm package
// fails that check immediately (UND_ERR_INVALID_ARG), before ever making a
// request. Using undici's own `fetch` export here (paired with an Agent
// from that same package instance) avoids the cross-instance mismatch.
// connectTimeout is separate from headersTimeout/bodyTimeout — it only bounds the TCP
// handshake, not the wait for opencode's response — so a stuck connection (e.g. a stale
// conntrack entry routing the SYN into a black hole) fails fast and lets the caller retry
// on a fresh socket, instead of silently tying up the 30-minute turn budget for nothing.
const longRunningDispatcher = new Agent({ connectTimeout: 10_000, headersTimeout: 1_800_000, bodyTimeout: 1_800_000 });

function authHeader(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

// undici's fetch returns undici's own Response type (its stream types don't
// line up with the DOM `Response` globals) — derive it instead of importing,
// so the fetch/agent pair always stays type-consistent.
type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

async function req<T>(baseUrl: string, password: string, path: string, init?: RequestInit): Promise<T> {
  const attempt = () =>
    undiciFetch(baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: authHeader(password), ...(init?.headers ?? {}) },
      dispatcher: longRunningDispatcher,
    } as Parameters<typeof undiciFetch>[1]);
  let res: UndiciResponse;
  try {
    res = await attempt();
  } catch (err: any) {
    // A stuck TCP handshake (e.g. a stale conntrack entry) never reaches the server, so
    // retrying once on a fresh connection is always safe here — unlike a timeout after the
    // request was already sent, which might have side effects and must surface as an error.
    if (err?.code !== "UND_ERR_CONNECT_TIMEOUT") throw err;
    console.warn(`[opencode] connect timeout on ${path}, retrying once on a fresh connection`);
    res = await attempt();
  }
  if (!res.ok) throw new Error(`opencode ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function createSession(baseUrl: string, password: string, signal?: AbortSignal): Promise<string> {
  const session = await req<{ id: string }>(baseUrl, password, "/session", { method: "POST", body: "{}", signal });
  return session.id;
}

/**
 * Cheap, side-effect-free connectivity check. `sendMessage` can legitimately take up to the
 * full 30-minute turn budget, so it can't carry a short AbortSignal itself — but a wedged TCP
 * handshake (stale conntrack entry) looks identical to a slow real turn from the caller's
 * side, so the only way to fail fast on the former without cutting off the latter is to probe
 * first, on a bounded timeout, before committing to the long call.
 */
export async function probeConnection(baseUrl: string, password: string): Promise<void> {
  await req(baseUrl, password, "/session/status", { signal: AbortSignal.timeout(10_000) });
}

/** Sends a prompt, waits for the full reply, returns its plain-text concatenation. */
export async function sendMessage(
  baseUrl: string,
  password: string,
  sessionId: string,
  text: string,
  model?: string,
): Promise<string> {
  const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
  // The API wants { providerID, modelID }, not a bare string. Every room only
  // has an OPENROUTER_API_KEY, so the provider is always "openrouter"; the
  // user-supplied model (e.g. "google/gemini-3.8-flash:batch") is the modelID
  // OpenRouter itself expects.
  if (model) body.model = { providerID: "openrouter", modelID: model };
  const res = await req<{
    info: { error?: { name: string; data?: { message?: string } } };
    parts: Array<{ type: string; text?: string }>;
  }>(baseUrl, password, `/session/${sessionId}/message`, { method: "POST", body: JSON.stringify(body) });
  // A rejected turn (e.g. context too large for the model) comes back as a normal 200 with
  // an empty `parts` and the real failure on `info.error` — silently treating that as "no
  // output" hides an actionable error behind a blank reply.
  if (res.info.error) {
    throw new Error(`opencode turn failed: ${res.info.error.data?.message ?? res.info.error.name}`);
  }
  return res.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Stops any ongoing AI processing/command execution for a session. Must be called whenever
 * our own client-side sendMessage call gives up (timeout or otherwise) — opencode has no
 * visibility into "the broker stopped waiting", so without this the turn keeps running
 * server-side forever, and since a session processes one turn at a time, every subsequent
 * message on that session queues silently behind it (zero CPU, zero network — just stuck
 * waiting its turn) instead of erroring.
 */
export async function abortSession(baseUrl: string, password: string, sessionId: string): Promise<void> {
  await req(baseUrl, password, `/session/${sessionId}/abort`, { method: "POST" });
}

export type SessionUsage = {
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  compactedAt?: number;
};

// Some providers/models routed through OpenRouter don't report cost (e.g. free-tier or
// BYOK routes), so callers must treat every field here as possibly absent rather than crash.
export async function getSessionUsage(baseUrl: string, password: string, sessionId: string): Promise<SessionUsage> {
  const session = await req<any>(baseUrl, password, `/session/${sessionId}`);
  return { cost: session?.cost, tokens: session?.tokens, compactedAt: session?.time?.compacting };
}

export async function respondPermission(
  baseUrl: string,
  password: string,
  sessionId: string,
  permissionId: string,
  approved: boolean,
): Promise<void> {
  await req(baseUrl, password, `/session/${sessionId}/permissions/${permissionId}`, {
    method: "POST",
    body: JSON.stringify({ response: approved ? "allow" : "deny" }),
  });
}

export type PermissionRequest = { sessionId: string; permissionId: string; description: string };
export type ToolProgress = { sessionId: string; title: string };
export type SessionError = { sessionId?: string; message: string };
export type SessionCostUpdate = { sessionId: string; cost?: number };

export type SseHandlers = {
  onPermission: (req: PermissionRequest) => void;
  onProgress: (progress: ToolProgress) => void;
  onSessionError: (err: SessionError) => void;
  onCostUpdate: (update: SessionCostUpdate) => void;
  onCompacted: (sessionId: string) => void;
};

/**
 * Maps one raw `/global/event` SSE payload onto the typed handlers. Kept as a
 * separate exported function so the (hand-rolled, see below) event-shape
 * guesses are unit-testable without a live opencode server.
 *
 * ponytail: the exact event field names below (`type`, `properties.sessionID`,
 * `.permissionID`, `.title`/`.description`, `message.part.updated`'s
 * `properties.part.{type,tool,state}`, `session.updated`'s `properties.info.cost`,
 * `session.compacted`'s `properties.sessionID`) are a best guess from opencode's
 * docs and SDK types, not confirmed against real traffic — unmatched events are
 * logged raw so the first live run makes any mismatch obvious and cheap to
 * fix in this one function.
 */
export function dispatchEvent(evt: any, handlers: SseHandlers): void {
  const props = evt.properties ?? evt;
  if (evt.type?.includes("permission") && props.permissionID) {
    handlers.onPermission({
      sessionId: props.sessionID,
      permissionId: props.permissionID,
      description: props.title ?? props.description ?? JSON.stringify(props).slice(0, 200),
    });
  } else if (evt.type === "message.part.updated" && props.part?.type === "tool" && props.part.state?.status === "running") {
    handlers.onProgress({
      sessionId: props.part.sessionID,
      title: props.part.state.title ?? props.part.tool,
    });
  } else if (evt.type === "session.error") {
    handlers.onSessionError({ sessionId: props.sessionID, message: JSON.stringify(props.error ?? props).slice(0, 200) });
  } else if (evt.type === "session.updated") {
    handlers.onCostUpdate({ sessionId: props.sessionID, cost: props.info?.cost });
  } else if (evt.type === "session.compacted") {
    handlers.onCompacted(props.sessionID);
  }
}

/** Feed one raw SSE `data:` line (already trimmed of its prefix) to dispatchEvent. */
function dispatchDataLine(line: string, handlers: SseHandlers): void {
  try {
    dispatchEvent(JSON.parse(line), handlers);
  } catch {
    // Not JSON or not a shape we recognize — ignore rather than crash the watcher.
  }
}

const SSE_RETRY_BASE_MS = 1_000;
const SSE_RETRY_MAX_MS = 30_000;

/**
 * Opens the room's SSE event stream and dispatches permission requests,
 * per-tool-call progress (so a long turn isn't silent end-to-end), session
 * errors, live cost updates (for the $-spent alert), and compaction events
 * (context got trimmed).
 *
 * Reconnects forever with capped exponential backoff until the returned stop()
 * is called — opencode's stream drops on any transient network blip, pod
 * restart, or proxy idle timeout, and a dead watcher silently kills the
 * approval flow (opencode waits for an allow/deny that is never relayed, so
 * the turn hangs forever with zero feedback in the room). The broker's
 * startPermissionWatcher() early-returns while a watcher entry exists, so
 * without internal reconnection a single drop would permanently deafen the
 * room.
 *
 * ponytail: events emitted while the stream is down are NOT backfilled —
 * opencode has no Last-Event-ID replay we can rely on, so a permission
 * request landing inside a reconnect gap can still be missed. The reconnect
 * window is seconds, vs the previous behavior of "down forever".
 */
export async function watchPermissions(
  baseUrl: string,
  password: string,
  onPermission: (req: PermissionRequest) => void,
  onProgress: (progress: ToolProgress) => void,
  onSessionError: (err: SessionError) => void,
  onCostUpdate: (update: SessionCostUpdate) => void,
  onCompacted: (sessionId: string) => void,
  onError: (err: unknown) => void,
): Promise<() => void> {
  const controller = new AbortController();
  const handlers: SseHandlers = { onPermission, onProgress, onSessionError, onCostUpdate, onCompacted };

  (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        const res = await undiciFetch(baseUrl + "/global/event", {
          headers: { authorization: authHeader(password) },
          signal: controller.signal,
          dispatcher: longRunningDispatcher,
        } as Parameters<typeof undiciFetch>[1]);
        if (!res.ok || !res.body) throw new Error(`/global/event -> ${res.status}`);
        attempt = 0; // healthy connection — reset backoff
        // Decode manually rather than pipeThrough(TextDecoderStream) — undici's
        // ReadableStream type doesn't line up with the DOM transform-stream types.
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            dispatchDataLine(line.slice(5).trim(), handlers);
          }
        }
        // Server closed the stream cleanly — treat like any other drop and reconnect.
        if (controller.signal.aborted) return;
        onError(new Error("event stream ended; reconnecting"));
      } catch (err) {
        if (controller.signal.aborted) return;
        onError(err);
      }
      const delay = Math.min(SSE_RETRY_MAX_MS, SSE_RETRY_BASE_MS * 2 ** attempt) + Math.random() * 500;
      attempt++;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  })();
  return () => controller.abort();
}
