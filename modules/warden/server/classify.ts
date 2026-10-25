/** Heuristics over an agent's last assistant message. Deterministic, no model calls. */

const FUTURE_WORK = [
  /\bi['’]?ll\s+(keep|continue|monitor|watch|check|wait|poll|follow|report|come back|get back|look|update|let you know|ping)\b/i,
  /\bi\s+will\s+(keep|continue|monitor|watch|check|wait|poll|follow|report|come back|get back|look|update|let you know)\b/i,
  /\bi['’]?m\s+(going to|about to|now)\s+(keep|continue|monitor|watch|check|wait|poll|run|start|look)/i,
  /\b(next|then),?\s+i['’]?ll\b/i,
  /\bwill\s+report\s+(back|when)\b/i,
  /\bkeep(ing)?\s+(an eye|watching|monitoring|polling)\b/i,
  /\b(standing by|waiting for|waiting on)\b/i,
  /\bnext step[s]?\s*:/i,
];

const DONE = [
  /\bfinal report\b/i,
  /\b(all|everything)\s+(is\s+)?(done|complete|finished|merged)\b/i,
  /\b(task|work|implementation|review)\s+(is\s+)?(done|complete|completed|finished)\b/i,
  /^\s*(done|complete|completed|finished)\b/im,
  /\bnothing (left|more) to do\b/i,
];

const BLOCKED = [/\bblocked\b/i, /\bneed(s)? (your|input|a decision|approval)\b/i, /\bcan['’]?t proceed\b/i];

export interface Report {
  /** The message announces work the agent has not done yet. */
  announcesFutureWork: boolean;
  /** The message reads as a final report that the work is done. */
  done: boolean;
  /** The sentence that states the next step, when there is one. */
  lastStep: string | null;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s>*\-•\d.)]+/, "").trim())
    .filter(Boolean);
}

export function analyze(text: string | null | undefined): Report {
  if (!text?.trim()) return { announcesFutureWork: false, done: false, lastStep: null };
  const parts = sentences(text);
  let lastStep: string | null = null;
  for (const sentence of parts) {
    if (FUTURE_WORK.some((re) => re.test(sentence))) lastStep = sentence;
  }
  const tail = parts.slice(-3).join(" ");
  const blocked = BLOCKED.some((re) => re.test(tail));
  const done = DONE.some((re) => re.test(text)) && !blocked;
  // Only the closing sentences decide: "I'll watch it" mid-report followed by a summary is a report.
  const closing = parts.slice(-2);
  const announces =
    !blocked && !done && lastStep !== null && closing.some((sentence) => sentence === lastStep);
  return { announcesFutureWork: announces, done, lastStep: announces ? lastStep : null };
}

/** The trailing run of assistant messages of a turn's timeline slice, joined (providers may chunk). */
export function lastAssistantText(timeline: readonly { type: string; text?: string }[]): string | null {
  const parts: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") {
      if (item.text) parts.unshift(item.text);
    } else if (parts.length > 0 && item.type !== "reasoning") {
      break;
    }
  }
  const text = parts.join("");
  return text.trim() ? text : null;
}
