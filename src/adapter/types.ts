/**
 * Transport-neutral contract between the chat layer and the broker core.
 *
 * A ChatAdapter is the ONLY place that knows about a specific chat platform
 * (Matrix today, someday Telegram/Slack/...): platform filters (msgtype,
 * timestamps, sync redelivery dedup), delivery chunking, redaction powers,
 * room labels, and how an approval question is phrased/answered. The
 * orchestrator (src/core/orchestrator.ts) speaks exclusively in these types.
 *
 * Conversation ids are adapter-supplied (Matrix roomId today) and opaque to
 * the core; never use transport details (power levels, event shapes) outside
 * an adapter.
 */
import { Context, Effect } from "effect";

export type ConversationId = string;

/** What a channel can do — drives rendering, chunking, and runner rules. */
export type ChannelCapabilities = {
  /** Whether the channel renders markdown (false => agent output must be plain text). */
  readonly markdown: boolean;
  /** Max chars per outbound message before the adapter must chunk. */
  readonly maxMessageChars: number;
  /** Whether the adapter can delete/redact a user's message (PAT scrubbing). */
  readonly canRedact: boolean;
  /** Formatting rules injected into the room's runner pod; undefined = runner's baked-in default. */
  readonly agentRules?: string;
};

/** A user message as seen by the core — already filtered/deduped by the adapter. */
export type InboundMessage = {
  readonly conversationId: ConversationId;
  /** Transport-native message id; supplied when the adapter supports redaction. */
  readonly messageId?: string;
  readonly senderId?: string;
  readonly text: string;
};

/**
 * Outbound, core → chat. Lightly typed so adapters can render per channel
 * (Matrix keeps its current emoji formatting; a rich client could render
 * approval-request as buttons and cost-alert as a card) without the core
 * caring about presentation. Freeform `status`/`info` carry their own text.
 */
export type OutboundEvent =
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "info"; readonly text: string }
  | { readonly type: "result"; readonly text: string }
  | { readonly type: "progress"; readonly title: string }
  | { readonly type: "error"; readonly text: string }
  | { readonly type: "usage"; readonly text: string }
  | { readonly type: "approval-request"; readonly description: string }
  | { readonly type: "approval-result"; readonly approved: boolean }
  | { readonly type: "cost-alert"; readonly stepUsd: number }
  | { readonly type: "compacted" }
  | { readonly type: "token-received"; readonly redacted: boolean }
  | { readonly type: "teardown"; readonly reason: string; readonly repo: string };

export interface ChatAdapterService {
  readonly capabilities: ChannelCapabilities;
  /** Registers the inbound handler and starts the transport. Resolves once the
   * transport is up; the transport itself keeps running in the background.
   * Error channel: a stable code, not an exception — the entry point logs the
   * raw cause and exits. */
  readonly start: (onInbound: (msg: InboundMessage) => void) => Effect.Effect<void, "chat-start-failed">;
  /** Renders and delivers one event. Must never fail (logs internally) — chat
   * delivery is best-effort and must not abort whatever the core is doing. */
  readonly send: (conversationId: ConversationId, event: OutboundEvent) => Effect.Effect<void>;
  /** Deletes a message from history (PAT scrubbing). False when it couldn't. */
  readonly redact: (conversationId: ConversationId, messageId: string) => Effect.Effect<boolean>;
  /** Human-readable conversation label for resource naming; undefined = no label. */
  readonly label: (conversationId: ConversationId) => Effect.Effect<string | undefined>;
  /**
   * Interprets a text message as an approval answer while one is pending:
   * true (allow) / false (deny). Only called for messages the core didn't
   * route as commands, so a channel can always reserve its command syntax.
   * Adapters with structured approval UIs (buttons) bypass this by design.
   */
  readonly parseApprovalAnswer: (text: string) => boolean;
}

export class ChatAdapter extends Context.Tag("coding-agent/ChatAdapter")<ChatAdapter, ChatAdapterService>() {}
