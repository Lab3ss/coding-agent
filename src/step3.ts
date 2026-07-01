/**
 * Step 3 — Matrix echo bot (plumbing spike, no agent yet).
 *
 * Logs in as the bot, auto-joins any room it's invited to, and echoes back any
 * text message it receives. This proves the Matrix round-trip end to end before
 * we wire the Claude agent in (Step 4).
 *
 * Run:  node src/step3.ts        (reads creds from .env)
 *
 * Note: use an UNENCRYPTED room for now — E2EE needs extra crypto setup and is a
 * later polish item.
 */
import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from "matrix-bot-sdk";

process.loadEnvFile(".env");

const homeserver = process.env.MATRIX_HOMESERVER!;
const token = process.env.MATRIX_TOKEN!;
if (!homeserver || !token) throw new Error("Set MATRIX_HOMESERVER and MATRIX_TOKEN in .env");

// Persists the sync token so restarts don't reprocess old messages.
const storage = new SimpleFsStorageProvider("bot-state.json");
const client = new MatrixClient(homeserver, token, storage);
AutojoinRoomsMixin.setupOnClient(client); // invited -> auto-join

// Ignore anything that arrived before this process started (avoids echoing history).
const startedAt = Date.now();

const me = await client.getUserId();
console.log(`Logged in as ${me} on ${homeserver}`);

client.on("room.message", async (roomId: string, event: any) => {
  if (event.sender === me) return; // don't echo ourselves
  if (!event.content || event.content.msgtype !== "m.text") return;
  if ((event.origin_server_ts ?? 0) < startedAt) return; // skip backlog

  const body: string = event.content.body ?? "";
  console.log(`[${roomId}] ${event.sender}: ${body}`);
  await client.sendText(roomId, `echo: ${body}`);
});

client.on("room.invite", (roomId: string, event: any) => {
  console.log(`invited to ${roomId} by ${event.sender} — auto-joining`);
});

await client.start();
console.log("Bot is running. Invite it to an (unencrypted) room and send a message.");
