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

async function req<T>(baseUrl: string, password: string, path: string, init?: RequestInit): Promise<T> {
  const attempt = () =>
    undiciFetch(baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: authHeader(password), ...(init?.headers ?? {}) },
      dispatcher: longRunningDispatcher,
    } as Parameters<typeof undiciFetch>[1]);
  let res: Response;
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
  const res = await req<{ parts: Array<{ type: string; text?: string }> }>(
    baseUrl,
    password,
    `/session/${sessionId}/message`,
    { method: "POST", body: JSON.stringify(body) },
  );
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

/**
 * Opens the room's SSE event stream and dispatches permission requests,
 * per-tool-call progress (so a long turn isn't silent end-to-end), session
 * errors, live cost updates (for the $-spent alert), and compaction events
 * (context got trimmed).
 *
 * ponytail: the exact event field names below (`type`, `properties.sessionID`,
 * `.permissionID`, `.title`/`.description`, `message.part.updated`'s
 * `properties.part.{type,tool,state}`, `session.updated`'s `properties.info.cost`,
 * `session.compacted`'s `properties.sessionID`) are a best guess from opencode's
 * docs and SDK types, not confirmed against real traffic — unmatched events are
 * logged raw so the first live run makes any mismatch obvious and cheap to
 * fix in this one function.
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
  (async () => {
    try {
      const res = await undiciFetch(baseUrl + "/global/event", {
        headers: { authorization: authHeader(password) },
        signal: controller.signal,
        dispatcher: longRunningDispatcher,
      } as Parameters<typeof undiciFetch>[1]);
      if (!res.ok || !res.body) throw new Error(`/global/event -> ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            const props = evt.properties ?? evt;
            if (evt.type?.includes("permission") && props.permissionID) {
              onPermission({
                sessionId: props.sessionID,
                permissionId: props.permissionID,
                description: props.title ?? props.description ?? JSON.stringify(props).slice(0, 200),
              });
            } else if (evt.type === "message.part.updated" && props.part?.type === "tool" && props.part.state?.status === "running") {
              onProgress({
                sessionId: props.part.sessionID,
                title: props.part.state.title ?? props.part.tool,
              });
            } else if (evt.type === "session.error") {
              onSessionError({ sessionId: props.sessionID, message: JSON.stringify(props.error ?? props).slice(0, 200) });
            } else if (evt.type === "session.updated") {
              onCostUpdate({ sessionId: props.sessionID, cost: props.info?.cost });
            } else if (evt.type === "session.compacted") {
              onCompacted(props.sessionID);
            }
          } catch {
            // Not JSON or not a shape we recognize — ignore rather than crash the watcher.
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) onError(err);
    }
  })();
  return () => controller.abort();
}
