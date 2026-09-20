/**
 * Persistent per-room registry (single global process now, not per-scope).
 * Survives restarts: repo/token/model/session persist even after a room's
 * pod is torn down (idle timeout or /stop), so the next message re-provisions
 * without re-asking onboarding questions.
 */
import { DatabaseSync } from "node:sqlite";

export type OnboardingStep = "repo" | "token" | "model";
export type Room = {
  roomId: string;
  onboarding?: OnboardingStep; // unset once repo+token+model are all known
  repo?: string;
  token?: string;
  model?: string;
  podName?: string; // set only while a pod is live
  sessionId?: string; // opencode session id; cleared when the pod is torn down
  lastActivity: number; // epoch ms
};

const db = new DatabaseSync(process.env.REGISTRY_DB_PATH ?? "registry.db");
db.exec(
  `CREATE TABLE IF NOT EXISTS rooms (
     room_id TEXT PRIMARY KEY, onboarding TEXT, repo TEXT, token TEXT, model TEXT,
     pod_name TEXT, session_id TEXT, last_activity INTEGER NOT NULL
   )`,
);

const rooms = new Map<string, Room>();
for (const row of db.prepare(`SELECT * FROM rooms`).all() as any[]) {
  rooms.set(row.room_id, {
    roomId: row.room_id,
    onboarding: row.onboarding ?? undefined,
    repo: row.repo ?? undefined,
    token: row.token ?? undefined,
    model: row.model ?? undefined,
    podName: row.pod_name ?? undefined,
    sessionId: row.session_id ?? undefined,
    lastActivity: row.last_activity,
  });
}

function persist(r: Room) {
  db.prepare(
    `INSERT INTO rooms (room_id, onboarding, repo, token, model, pod_name, session_id, last_activity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET onboarding=excluded.onboarding, repo=excluded.repo,
       token=excluded.token, model=excluded.model, pod_name=excluded.pod_name,
       session_id=excluded.session_id, last_activity=excluded.last_activity`,
  ).run(
    r.roomId,
    r.onboarding ?? null,
    r.repo ?? null,
    r.token ?? null,
    r.model ?? null,
    r.podName ?? null,
    r.sessionId ?? null,
    r.lastActivity,
  );
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function newRoom(roomId: string): Room {
  const r: Room = { roomId, onboarding: "repo", lastActivity: Date.now() };
  rooms.set(roomId, r);
  persist(r);
  return r;
}

export function saveRoom(r: Room) {
  rooms.set(r.roomId, r);
  persist(r);
}

export function touch(roomId: string) {
  const r = rooms.get(roomId);
  if (r) {
    r.lastActivity = Date.now();
    persist(r);
  }
}

/** Rooms with a live pod that have been idle longer than `maxIdleMs`. */
export function idleRooms(maxIdleMs: number): Room[] {
  const cutoff = Date.now() - maxIdleMs;
  return [...rooms.values()].filter((r) => r.podName && r.lastActivity < cutoff);
}
