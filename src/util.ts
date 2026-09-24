/**
 * Small pure helpers shared across the broker — kept dependency-free so they
 * can be unit-tested without touching Matrix, the k8s API, or a live pod.
 */
import type { SessionUsage } from "./opencode.ts";

export function parseRepo(text: string): string | null {
  // Find a GitHub URL anywhere in the message — users paste it mid-sentence,
  // with /tree/<branch>, /blob/<path>, a .git suffix, or trailing punctuation
  // ("clone https://github.com/a/b/tree/main please", "see https://github.com/a/b).").
  const url = text.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/[^\s]*)?(?=$|[\s.,;!?:)])/i);
  if (url) return url[1];
  const t = text.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return t;
  return null;
}

// fetch() wraps the real undici error (e.g. UND_ERR_HEADERS_TIMEOUT, UND_ERR_CONNECT_TIMEOUT)
// in a generic `TypeError: fetch failed` with the actual cause on `.cause` — logging err.message
// alone just prints "fetch failed" with no way to tell a timeout from a connect error.
export function describeError(err: unknown): string {
  const e = err as { cause?: { code?: string; message?: string }; code?: string; message?: string };
  const code = e?.cause?.code ?? e?.code;
  const message = e?.cause?.message ?? e?.message ?? String(err);
  return code ? `${message} (code=${code})` : message;
}

export function formatUsage(usage: SessionUsage): string {
  const cost = typeof usage.cost === "number" ? `$${usage.cost.toFixed(4)}` : "n/a (not reported for this model)";
  const t = usage.tokens;
  const tokens = t
    ? `in: ${t.input} · out: ${t.output} · reasoning: ${t.reasoning} · cache read: ${t.cache.read} · cache write: ${t.cache.write}`
    : "n/a";
  const context = usage.compactedAt ? `compacted at ${new Date(usage.compactedAt).toLocaleString()}` : "not compacted";
  return `📊 Usage for this session\n💰 Cost: ${cost}\n🔢 Tokens — ${tokens}\n🗜️ Context: ${context}`;
}

/**
 * Matrix events have a hard size limit (~64KB server-side); opencode replies
 * (full file listings, long summaries) can exceed it, and one oversized
 * sendText would lose the whole turn output. Split on line boundaries into
 * chunks that are individually safe to send, in order.
 */
export function splitForMatrix(text: string, chunkSize = 3000): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkSize) {
    let cut = rest.lastIndexOf("\n", chunkSize);
    if (cut < chunkSize / 2) cut = chunkSize; // no good line boundary — hard-split
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, ""); // drop the newline(s) we split on
  }
  if (rest) chunks.push(rest);
  return chunks;
}
