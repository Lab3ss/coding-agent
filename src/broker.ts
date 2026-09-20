/**
 * Broker — single global instance, no repo access of its own.
 *
 * Invited to a Matrix room, it asks for a repo, a GitHub PAT scoped to that
 * repo, and a model (any OpenRouter model id) — then provisions an isolated,
 * throwaway pod for that room (see src/k8s.ts) running a headless `opencode
 * serve` (see runner/), and relays messages to/from it (see src/opencode.ts).
 *
 * Idle rooms (>IDLE_TEARDOWN_HOURS, default 24h) or an explicit `/stop` tear
 * their pod down; the room's repo/token/model stay remembered (src/registry.ts)
 * so the next message re-provisions without re-asking. Since there's no PVC,
 * re-provisioning starts a fresh opencode session — conversation context does
 * not survive a teardown, only the project config does.
 *
 * Requires: MATRIX_HOMESERVER, MATRIX_TOKEN (this bot's account),
 * OPENROUTER_API_KEY (the one and only LLM credential, shared into every
 * room's pod at provision time — never stored per-room in Git).
 */
import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } from "matrix-bot-sdk";
import { getRoom, newRoom, saveRoom, touch, idleRooms, type Room } from "./registry.ts";
import { provisionRoom, teardownRoom, roomResourceName, roomServerUrl, waitForRunning, getRoomServerPassword } from "./k8s.ts";
import { createSession, sendMessage, respondPermission, watchPermissions } from "./opencode.ts";

const homeserver = process.env.MATRIX_HOMESERVER!;
const matrixToken = process.env.MATRIX_TOKEN!;
const openrouterKey = process.env.OPENROUTER_API_KEY!;
const idleTeardownMs = parseFloat(process.env.IDLE_TEARDOWN_HOURS ?? "24") * 3600_000;
const sweepIntervalMs = 15 * 60_000;

if (!homeserver || !matrixToken) throw new Error("MATRIX_HOMESERVER and MATRIX_TOKEN required");
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY required");

const client = new MatrixClient(homeserver, matrixToken, new SimpleFsStorageProvider("bot-state.json"));
AutojoinRoomsMixin.setupOnClient(client);
const startedAt = Date.now();
const me = await client.getUserId();
console.log(`[coding-agent] up as ${me} on ${homeserver}`);

function parseRepo(text: string): string | null {
  const t = text.trim();
  const url = t.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (url) return url[1];
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return t;
  return null;
}

// Live-pod-only state, never persisted: the opencode server password (fresh
// every provision) and the SSE watcher's stop function.
const serverPasswords = new Map<string, string>(); // roomId -> password
const permissionWatchers = new Map<string, () => void>(); // roomId -> stop()
const pendingApprovals = new Map<string, (approved: boolean) => void>(); // roomId -> resolver
const busyRooms = new Set<string>();

async function startPermissionWatcher(room: Room) {
  if (permissionWatchers.has(room.roomId)) return;
  const password = serverPasswords.get(room.roomId);
  if (!password) return;
  const baseUrl = roomServerUrl(room.podName!);
  const stop = await watchPermissions(
    baseUrl,
    password,
    async (permReq) => {
      await client.sendText(
        room.roomId,
        `🔐 Approval needed:\n${permReq.description}\nReply *yes* to allow, anything else to deny. No rush — I'll wait as long as it takes.`,
      );
      const approved = await new Promise<boolean>((resolve) => pendingApprovals.set(room.roomId, resolve));
      await respondPermission(baseUrl, password, permReq.sessionId, permReq.permissionId, approved).catch((err) =>
        client.sendText(room.roomId, `⚠️ failed to record approval: ${err?.message ?? err}`),
      );
    },
    (err) => console.warn(`[${room.roomId}] permission watcher error:`, err?.message ?? err),
  );
  permissionWatchers.set(room.roomId, stop);
}

function stopPermissionWatcher(roomId: string) {
  permissionWatchers.get(roomId)?.();
  permissionWatchers.delete(roomId);
  serverPasswords.delete(roomId);
}

/**
 * No-op if already provisioned; re-provisions (fresh session) if idle-torn-down.
 * If the pod is already live but the broker restarted since (losing its
 * in-memory serverPasswords/permissionWatchers), recovers the password from
 * the Secret and restarts the watcher rather than assuming they're set.
 */
async function ensureProvisioned(room: Room): Promise<void> {
  if (room.podName) {
    if (!serverPasswords.has(room.roomId)) {
      serverPasswords.set(room.roomId, await getRoomServerPassword(room.podName));
    }
    await startPermissionWatcher(room);
    return;
  }
  const name = roomResourceName(room.roomId);
  const password = await provisionRoom(name, { repo: room.repo!, token: room.token!, openrouterKey });
  serverPasswords.set(room.roomId, password);
  await waitForRunning(name);
  const baseUrl = roomServerUrl(name);
  const sessionId = await retryUntilReady(() => createSession(baseUrl, password));
  room.podName = name;
  room.sessionId = sessionId;
  saveRoom(room);
  await startPermissionWatcher(room);
}

/** The container is Running before opencode's HTTP server inside it is actually listening. */
async function retryUntilReady<T>(fn: () => Promise<T>, attempts = 10, delayMs = 2000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function teardown(room: Room, reason: string) {
  stopPermissionWatcher(room.roomId);
  if (room.podName) await teardownRoom(room.podName).catch(() => {});
  room.podName = undefined;
  room.sessionId = undefined;
  saveRoom(room);
  await client.sendText(room.roomId, `🛑 Stopped (${reason}). ${room.repo} is still remembered — send a message to resume.`);
}

setInterval(async () => {
  for (const room of idleRooms(idleTeardownMs)) {
    console.log(`[${room.roomId}] idle >${(idleTeardownMs / 3600_000).toFixed(1)}h — tearing down`);
    await teardown(room, "idle").catch((err) => console.warn(`[${room.roomId}] teardown failed:`, err));
  }
}, sweepIntervalMs);

client.on("room.message", async (roomId: string, event: any) => {
  if (event.sender === me) return;
  if (!event.content || event.content.msgtype !== "m.text") return;
  if ((event.origin_server_ts ?? 0) < startedAt) return;

  const body: string = (event.content.body ?? "").trim();
  touch(roomId);

  // If this room is waiting on an approval, this message IS the answer.
  const pending = pendingApprovals.get(roomId);
  if (pending) {
    pendingApprovals.delete(roomId);
    const approved = /^(y|yes|ok|okay|approve|approved|go|sure|👍|✅)\b/i.test(body);
    await client.sendText(roomId, approved ? "✅ Approved — proceeding." : "🚫 Denied.");
    pending(approved);
    return;
  }

  if (/^\/stop\b/i.test(body)) {
    const room = getRoom(roomId);
    if (!room?.podName) await client.sendText(roomId, "Nothing running here.");
    else await teardown(room, "requested");
    return;
  }

  if (busyRooms.has(roomId)) {
    await client.sendText(roomId, "Still working on the previous request — one moment.");
    return;
  }

  const room = getRoom(roomId) ?? newRoom(roomId);

  if (room.onboarding === "repo") {
    const repo = parseRepo(body);
    if (!repo) {
      await client.sendText(roomId, "What repo should I work on? Reply with `owner/name` or a GitHub URL.");
      return;
    }
    room.repo = repo;
    room.onboarding = "token";
    saveRoom(room);
    await client.sendText(
      roomId,
      `Got it: ${repo}. Now send a GitHub PAT scoped to that repo — it's used only inside this room's isolated pod, never shared with any other room.`,
    );
    return;
  }

  if (room.onboarding === "token") {
    if (body.length < 10) {
      await client.sendText(roomId, "That doesn't look like a token — send the GitHub PAT for this repo.");
      return;
    }
    room.token = body;
    room.onboarding = "model";
    saveRoom(room);
    // Best-effort: strip the PAT out of room history right after reading it.
    // Not a security boundary (the homeserver may retain it briefly, and
    // redaction can't reach anywhere the room already federated), just
    // closes the main practical exposure — nobody scrolling back sees it.
    // Redacting someone else's event (the human's own message) needs
    // moderator+ power level in the room — report honestly if we don't have it
    // rather than claiming success either way.
    const redacted = await client
      .redactEvent(roomId, event.event_id, "token removed from history")
      .then(() => true)
      .catch((err) => {
        console.warn(`[${roomId}] failed to redact token message:`, err?.message ?? err);
        return false;
      });
    await client.sendText(
      roomId,
      redacted
        ? "Got it (and removed that message from the room history). Which model? (any OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5` — see openrouter.ai/models)"
        : "Got it. ⚠️ I couldn't remove that message from history (I need moderator power level in this room to redact it) — make me a moderator if you want that. Which model? (any OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5` — see openrouter.ai/models)",
    );
    return;
  }

  if (room.onboarding === "model") {
    room.model = body;
    room.onboarding = undefined;
    saveRoom(room);
    busyRooms.add(roomId);
    try {
      await client.sendText(roomId, `Setting up ${room.repo}…`);
      await ensureProvisioned(room);
      await client.sendText(roomId, "✅ Ready. What would you like me to do?");
    } catch (err: any) {
      await client.sendText(roomId, `⚠️ setup failed: ${err?.message ?? err}`);
    } finally {
      busyRooms.delete(roomId);
    }
    return;
  }

  // Steady state: repo/token/model all known.
  busyRooms.add(roomId);
  try {
    await ensureProvisioned(room); // transparently re-provisions if idle-torn-down
    await client.sendText(roomId, "🛠️ on it…");
    const password = serverPasswords.get(roomId)!;
    const baseUrl = roomServerUrl(room.podName!);
    const reply = await sendMessage(baseUrl, password, room.sessionId!, body, room.model);
    await client.sendText(roomId, reply || "(no output)");
  } catch (err: any) {
    await client.sendText(roomId, `⚠️ ${err?.message ?? err}`);
  } finally {
    busyRooms.delete(roomId);
  }
});

await client.start();
console.log("[coding-agent] listening. Invite me to a room to onboard a project.");
