import type { TranscriptMessage } from "../shared/rpc";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The last messages of an agent from a timeline page: user and assistant text, errors, and one line per tool call.
 * Accepts entries shaped `{ item, timestamp }` or bare items, since the page shape differs by projection.
 */
export function messagesFromTimeline(payload: unknown, limit: number): TranscriptMessage[] {
  const entries: unknown[] = Array.isArray((payload as { entries?: unknown[] })?.entries) ? (payload as { entries: unknown[] }).entries : [];
  const out: TranscriptMessage[] = [];
  for (const entry of entries) {
    const e = entry as { item?: any; timestamp?: string; at?: string } & Record<string, any>;
    const item = e.item ?? e;
    const at = typeof e.timestamp === "string" ? e.timestamp : typeof e.at === "string" ? e.at : null;
    switch (item?.type) {
      case "user_message":
        out.push({ role: "user", text: clip(String(item.text ?? ""), 1500), at });
        break;
      case "assistant_message": {
        const last = out[out.length - 1];
        // Streamed assistant text arrives in chunks: join neighbours.
        if (last?.role === "assistant") last.text = clip(`${last.text}${item.text ?? ""}`, 1500);
        else out.push({ role: "assistant", text: clip(String(item.text ?? ""), 1500), at });
        break;
      }
      case "tool_call":
        out.push({ role: "tool", text: clip(String(item.name ?? item.detail?.type ?? "tool"), 120), at });
        break;
      case "error":
        out.push({ role: "error", text: clip(String(item.message ?? "error"), 500), at });
        break;
      default:
        break;
    }
  }
  return out.slice(-limit);
}
