/**
 * Matrix chat adapter — transport #1.
 *
 * The ONLY module that knows about Matrix: sync redelivery dedup, message
 * filters (own messages, non-text, pre-start events), event rendering with
 * the current emoji formatting, redaction (needs moderator power level), room
 * labels, and how approval prompts are phrased/answered. Swap this file for
 * another platform without touching the core (src/core/orchestrator.ts).
 *
 * Rendering notes: events carry semantics, not presentation — the emoji
 * prefixes below are this channel's rendering choices, and `result` output is
 * chunked to Matrix's event size limit (see capabilities.maxMessageChars).
 */
import { AutojoinRoomsMixin, MatrixClient, SimpleFsStorageProvider } from "matrix-bot-sdk";
import { Effect, Layer } from "effect";
import { ChatAdapter, type ChannelCapabilities, type InboundMessage, type OutboundEvent } from "./types.ts";
import { describeError, splitForMatrix } from "../util.ts";

export type MatrixAdapterConfig = {
  readonly homeserver: string;
  readonly token: string;
  /** Where the sync token/filter state persists (usually on the /data volume). */
  readonly storagePath: string;
};

/** Matrix clients render plain text only — this profile is injected into every
 * room's runner pod as AGENT_RULES (see runner/entrypoint.sh) so the agent's
 * output is readable here. Must stay in sync with the baked-in default
 * (runner/opencode-rules.md), which exists only for standalone/manual pods. */
export const CHANNEL_RULES = `# Chat output rules

These rules apply to every session in this deployment, on every response.
Your responses are relayed verbatim into a plain-text chat channel read on a
phone. Chat clients render plain text only: markdown is NOT rendered —
asterisks, hashes, pipes, and backticks appear as raw characters, and markdown
tables are especially unreadable.

This takes precedence over any formatting or communication conventions found
in the repo's own AGENTS.md or README.

## Rule 1 — plain text only, no Markdown at all

Write every response in plain text, with concrete replacements:

- No tables — put one item per line as "label: value" lines instead.
- No headers (#), bold/italic (**, _), or markdown bullet markers (-, *) —
  use short plain lines instead.
- No code fences (\`\`\`) or inline backticks — indent code, commands, and file
  snippets with spaces instead.
- No markdown links [text](url) — paste bare URLs.

## Rule 2 — chat-native communication

You are working with one person through a chat room, usually read on a
phone. Use a co-pilot framing: a senior colleague pair-programming over
chat — not a report generator, not a terminal UI.

- Lead with the outcome first, then compact summaries of what changed,
  where, and what's next. Keep it brief and phone-friendly.
- Avoid code snippets when possible; when one really is needed, indent it
  (see Rule 1) and keep it to the few lines that matter.
- Don't dump raw tool output or logs into the room — name the file and
  quote only the lines that matter.
- If a request is ambiguous or bigger than it looks, ask one clear question
  before doing the wrong thing.

## Rule 3 — challenge when you think it's needed

Have an opinion, but always back it up with arguments.

- If the user's request, design choice, or stated opinion looks suboptimal,
  buggy, or risky, speak up once — concretely, with clear reasoning —
  before or while implementing it, not after.
- Prefer one concrete sentence ("X will break because Y; consider Z") over
  silent compliance or a long lecture.
- If they confirm their choice after hearing you out, do the work without
  relitigating it.`;

function render(event: OutboundEvent): string {
  switch (event.type) {
    case "status":
    case "info":
    case "usage":
      return event.text;
    case "result":
      return event.text;
    case "progress":
      return `🔧 ${event.title}`;
    case "error":
      return `⚠️ ${event.text}`;
    case "approval-request":
      return `🔐 Approval needed:\n${event.description}\nReply *yes* to allow, anything else to deny. No rush — I'll wait as long as it takes.`;
    case "approval-result":
      return event.approved ? "✅ Approved — proceeding." : "🚫 Denied.";
    case "cost-alert":
      return `💸 ~$${event.stepUsd} spent so far this session. Send /usage for the full breakdown.`;
    case "compacted":
      return "🗜️ Context got compacted (older history was trimmed to make room).";
    case "token-received":
      return event.redacted
        ? "Got it (and removed that message from the room history). Which model? (any OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5` — see openrouter.ai/models)"
        : "Got it. ⚠️ I couldn't remove that message from history (I need moderator power level in this room to redact it) — make me a moderator if you want that. Which model? (any OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5` — see openrouter.ai/models)";
    case "teardown":
      return `🛑 Stopped (${event.reason}). ${event.repo} is still remembered — send a message to resume.`;
  }
}

// Same approval vocabulary as before the split: "y", "yes", "ok", "go"…
// allow; anything else (that isn't a command — the core checks those first)
// denies. A future adapter with approval buttons ignores this entirely.
const APPROVAL_ANSWER_RE = /^(y|yes|ok|okay|approve|approved|go|sure|👍|✅)\b/i;

// Matrix sync can redeliver events across reconnects; without dedup a single
// redelivered "run this task" gets answered twice. Capped so it can't grow
// without bound; clearing at the cap is fine — duplicates only matter within
// seconds of each other, and even the smallest cap far exceeds that.
const SEEN_EVENT_IDS_CAP = 2000;

const makeMatrixAdapter = (config: MatrixAdapterConfig) =>
  Effect.gen(function* () {
    const client = new MatrixClient(config.homeserver, config.token, new SimpleFsStorageProvider(config.storagePath));
    AutojoinRoomsMixin.setupOnClient(client); // join when invited — this channel's membership policy
    const me = yield* Effect.tryPromise(() => client.getUserId());
    const startedAt = Date.now();
    console.log(`[coding-agent] matrix adapter up as ${me} on ${config.homeserver}`);

    const seenEventIds = new Set<string>();

    const capabilities: ChannelCapabilities = {
      markdown: false,
      maxMessageChars: 3000,
      canRedact: true,
      agentRules: CHANNEL_RULES,
    };

    const send = (conversationId: string, event: OutboundEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const text = render(event);
        console.log(`[${conversationId}] → ${event.type}`);
        for (const part of splitForMatrix(text, capabilities.maxMessageChars)) {
          yield* Effect.tryPromise(() => client.sendText(conversationId, part));
        }
      }).pipe(
        // Never fail the core because chat delivery hiccuped.
        Effect.catchAll((err) =>
          Effect.sync(() => console.warn(`[${conversationId}] failed to send ${event.type}:`, describeError(err))),
        ),
      );

    const redact = (conversationId: string, messageId: string): Effect.Effect<boolean> =>
      Effect.tryPromise(() => client.redactEvent(conversationId, messageId, "token removed from history")).pipe(
        Effect.as(true),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            console.warn(`[${conversationId}] failed to redact token message:`, describeError(err));
            return false;
          }),
        ),
      );

    const label = (conversationId: string): Effect.Effect<string | undefined> =>
      Effect.tryPromise(() => client.getRoomStateEvent(conversationId, "m.room.name", "")).pipe(
        Effect.map((state) => state?.name as string | undefined),
        Effect.catchAll(() => Effect.succeed(undefined)),
      );

    const start = (onInbound: (msg: InboundMessage) => void): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        client.on("room.message", (roomId: string, event: any) => {
          if (event.sender === me) return;
          if (!event.content || event.content.msgtype !== "m.text") return;
          if ((event.origin_server_ts ?? 0) < startedAt) return;
          const eventId: string | undefined = event.event_id;
          if (eventId) {
            if (seenEventIds.has(eventId)) return;
            seenEventIds.add(eventId);
            if (seenEventIds.size > SEEN_EVENT_IDS_CAP) seenEventIds.clear();
          }
          onInbound({
            conversationId: roomId,
            messageId: eventId,
            senderId: event.sender,
            text: (event.content.body ?? "").trim(),
          });
        });
        yield* Effect.tryPromise(() => client.start());
      });

    return {
      capabilities,
      send,
      redact,
      label,
      start,
      parseApprovalAnswer: (text: string) => APPROVAL_ANSWER_RE.test(text),
    } satisfies import("./types.ts").ChatAdapterService;
  });

export const MatrixAdapterLive = (config: MatrixAdapterConfig) => Layer.effect(ChatAdapter, makeMatrixAdapter(config));
