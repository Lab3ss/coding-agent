/**
 * Registry behind an Effect service — lets the orchestrator (and its tests)
 * run against the real SQLite registry or an in-memory fake without knowing
 * which. Method bodies are sync (node:sqlite) and never fail at the type level.
 */
import { Context, Layer } from "effect";
import { deleteRoom, getRoom, idleRooms, newRoom, saveRoom, touch, type Room } from "../registry.ts";

export type { Room };

export interface RegistryService {
  readonly get: (conversationId: string) => Room | undefined;
  readonly create: (conversationId: string) => Room;
  readonly save: (room: Room) => void;
  readonly touch: (conversationId: string) => void;
  /** Rooms with a live pod idle longer than maxIdleMs. */
  readonly idle: (maxIdleMs: number) => Room[];
  /** Purges a conversation entirely — see registry.ts's deleteRoom for when this is safe. */
  readonly delete: (conversationId: string) => void;
}

export class Registry extends Context.Tag("coding-agent/Registry")<Registry, RegistryService>() {}

export const RegistryLive = Layer.sync(Registry, () => ({
  get: getRoom,
  create: newRoom,
  save: saveRoom,
  touch,
  idle: idleRooms,
  delete: deleteRoom,
}));
