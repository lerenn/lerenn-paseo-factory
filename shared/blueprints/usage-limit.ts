// Provider usage limits (Claude Code "usage limit reached", HTTP 429 rate_limit_error, Codex usage_limit_reached): a strict
// classifier over the structured terminal error of a failed turn, and the RPCs of the Quota sub-tab. Pure: no I/O, importable
// by the server, the client and other plugins. Decision f007d95a / b05f2c5c.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The terminal error of a failed turn or prompt, as Paseo gives it (`PluginTurnOutcome.error`, `ProviderError`). */
export interface ProviderFailure {
  message: string;
  /** Structured error code (`rate_limit_error`, `usage_limit_reached`...), when the provider gives one. */
  code?: string | null;
  diagnostic?: string | null;
  /** Structured HTTP status, when known. */
  status?: number | null;
  provider?: string | null;
}

export type Classification =
  | { kind: "usage_limit"; rule: string; resetAt: number | null; evidence: string }
  /** `rule` names a known non-usage-limit class (overloaded, network, auth...); null: an error nobody classified yet. */
  | { kind: "other"; rule: string | null };

/** Reset times further than this are not trusted: the run probes instead. */
export const MAX_RESET_MS = 7 * 24 * 3600_000;

/** Structured codes that mean the account's usage or rate limit was hit. */
const LIMIT_CODES = new Set(["rate_limit_error", "rate_limit", "usage_limit_reached", "rate_limit_exceeded", "429"]);

/** Codes that are explicitly not a usage limit (normal path). */
const OTHER_CODES: Record<string, string> = {
  overloaded_error: "overloaded",
  "529": "overloaded",
  api_error: "server error",
  server_error: "server error",
  authentication_error: "auth",
  authentication_failed: "auth",
  permission_error: "auth",
  billing_error: "billing",
  invalid_request_error: "invalid request",
  invalid_request: "invalid request",
  not_found_error: "invalid request",
  request_too_large: "context too long",
};

/** Known classes of errors that are not usage limits, so they raise no "unknown error" alert. Order matters only for the label. */
const KNOWN_OTHER: Array<[RegExp, string]> = [
  [/\b529\b|overloaded/i, "overloaded"],
  [/exceeded quota/i, "kubernetes quota"],
  [/prompt is too long|context (?:length|window)|too many tokens|maximum context|request_too_large/i, "context too long"],
  [/\b(?:401|403)\b|authenticat|unauthori[sz]ed|invalid api key|oauth|please run \/login|not logged in|credit balance/i, "auth"],
  [/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|getaddrinfo|TLS|certificate/i, "network"],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|api_error/i, "server error"],
  [/permission|not allowed|denied|tool[_ ]use|tool .*failed|invalid_request_error/i, "tool or permission"],
  [/aborted|interrupted|cancel+ed/i, "canceled"],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Offset of `zone` from UTC at `t`, in ms (positive east of Greenwich). Throws on an unknown zone. */
function zoneOffset(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The epoch of a wall-clock date in `zone`. */
function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffset(guess, zone);
  return guess - zoneOffset(first, zone);
}

/**
 * The next time a wall clock reads `h:mi` in `zone` after `now` (or that exact day when `month`/`day` are given).
 * Null when the zone is unknown or the time is in the past.
 */
function nextWallClock(now: number, h: number, mi: number, zone: string, date?: { month: number; day: number }): number | null {
  try {
    const local = new Date(now + zoneOffset(now, zone));
    const y = local.getUTCFullYear();
    if (date) {
      let at = wallToEpoch(y, date.month, date.day, h, mi, zone);
      if (at <= now - 3600_000) at = wallToEpoch(y + 1, date.month, date.day, h, mi, zone); // "Jan 2" seen on Dec 31
      return at;
    }
    let at = wallToEpoch(y, local.getUTCMonth(), local.getUTCDate(), h, mi, zone);
    if (at <= now) at = wallToEpoch(y, local.getUTCMonth(), local.getUTCDate() + 1, h, mi, zone);
    return at;
  } catch {
    return null;
  }
}

/**
 * The reset time in a provider's sentence: "3pm", "3:30 PM", "15:00", optionally "(Europe/Paris)" or "Oct 30, 3pm", or a
 * duration "in 4 days 2 hours 1 minute". Null when there is none or it cannot be read.
 */
export function parseResetTime(text: string, now: number, defaultZone = "UTC"): number | null {
  const dur = /\bin\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (dur) {
    let ms = 0;
    for (const m of dur[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const n = Number(m[1]);
      const u = m[2].toLowerCase();
      ms += u.startsWith("d") ? n * 86_400_000 : u.startsWith("h") ? n * 3_600_000 : u.startsWith("m") ? n * 60_000 : n * 1000;
    }
    return ms > 0 ? now + ms : null;
  }
  const clock = /(?:\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?\b(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?=[\s(.,]|$)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i.exec(text);
  if (!clock) return null;
  let h = Number(clock[3]);
  const mi = clock[4] ? Number(clock[4]) : 0;
  const ampm = clock[5]?.toLowerCase().replace(/\./g, "");
  if (!ampm && !clock[4]) return null; // a bare number is not a time
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === "pm" ? 12 : 0);
  }
  if (h > 23 || mi > 59) return null;
  const zone = clock[6] ?? defaultZone;
  const monthIdx = clock[1] ? MONTHS.indexOf(clock[1].toLowerCase()) : -1;
  return nextWallClock(now, h, mi, zone, monthIdx >= 0 ? { month: monthIdx, day: Number(clock[2]) } : undefined);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A plausible reset time, else null (past, or further than MAX_RESET_MS). */
const sane = (at: number | null, now: number) => (at !== null && at > now - 60_000 && at - now <= MAX_RESET_MS ? at : null);

/** "API Error: 429 {json}" (Claude Code's terminal form once its own retries gave up): the status and the JSON error type. */
function apiError(message: string): { status: number; type: string | null } | null {
  const m = /^\s*(?:Error:\s*)?API Error:\s*(\d{3})\b\s*(\{[\s\S]*\})?\s*$/.exec(message);
  if (!m) return null;
  let type: string | null = null;
  if (m[2]) {
    try {
      const body = JSON.parse(m[2]) as { error?: { type?: unknown }; type?: unknown };
      const t = body.error?.type ?? body.type;
      type = typeof t === "string" ? t : null;
    } catch {
      type = null;
    }
  }
  return { status: Number(m[1]), type };
}

/** Provider sentences, anchored on the whole message (never a word inside a longer text). */
const SENTENCES: Array<{ rule: string; re: RegExp; reset: (m: RegExpExecArray, now: number, zone: string) => number | null }> = [
  {
    // Codex: "You've hit your usage limit. Upgrade to Pro (...) or try again in 4 days 2 hours 1 minute." / "... try again at 3:04 PM."
    rule: "codex-usage-limit",
    re: /^\s*(?:■\s*)?(?:Error:\s*)?you(?:'|’)ve hit your usage limit\b([^\n]{0,300})$/i,
    reset: (m, now, zone) => (/try again/i.test(m[1]) ? parseResetTime(m[1].replace(/^[\s\S]*?try again\s*/i, ""), now, zone) : null),
  },
  {
    // Claude Code (older): "Claude AI usage limit reached|1793372460"
    rule: "claude-usage-limit-epoch",
    re: /^\s*(?:Error:\s*)?Claude AI usage limit reached\|(\d{9,11})\s*$/i,
    reset: (m) => Number(m[1]) * 1000,
  },
  {
    // Claude Code: "Claude usage limit reached. Your limit will reset at 3pm (Europe/Paris)." / "5-hour limit reached ∙ resets 3pm" /
    // "You've hit your limit · resets 3pm (UTC)" / "Weekly limit reached ∙ resets Oct 30, 3pm"
    rule: "claude-limit-reached",
    re: /^\s*(?:Error:\s*)?(?:Claude (?:AI )?usage limit reached|(?:5-hour|session|weekly|opus(?: weekly)?|usage) limit reached|you(?:'|’)ve (?:hit|reached) your (?:usage |session |weekly |opus |5-hour )?limit)\b([^\n]{0,160})$/i,
    reset: (m, now, zone) => (/\breset/i.test(m[1]) ? parseResetTime(m[1].replace(/^[\s\S]*?\breset[s]?\b/i, ""), now, zone) : null),
  },
];

/**
 * Strict: a usage limit only on an explicit signal. Structured fields first (`code`, `status`, the JSON of "API Error: 429 {...}"),
 * then the provider's own sentence anchored on the whole message. Never free text "limit"/"429" in passing. `zone` is the zone a
 * clock time without one is read in (the CLI's own, usually the pod's UTC).
 */
export function classifyUsageLimit(f: ProviderFailure, now: number, zone = "UTC"): Classification {
  const message = (f.message ?? "").trim();
  const code = f.code?.trim().toLowerCase() || null;
  const evidence = clip(`${code ? `code=${code} ` : ""}${f.status ? `status=${f.status} ` : ""}${message}`.trim(), 300);
  for (const s of SENTENCES) {
    const m = s.re.exec(message);
    if (m) return { kind: "usage_limit", rule: s.rule, resetAt: sane(s.reset(m, now, zone), now), evidence };
  }
  if (code && LIMIT_CODES.has(code)) return { kind: "usage_limit", rule: `code:${code}`, resetAt: null, evidence };
  if (f.status === 429) return { kind: "usage_limit", rule: "status:429", resetAt: null, evidence };
  const api = apiError(message);
  if (api && (api.status === 429 || (api.type && LIMIT_CODES.has(api.type)))) return { kind: "usage_limit", rule: `api-error:${api.type ?? api.status}`, resetAt: null, evidence };
  if (code && OTHER_CODES[code]) return { kind: "other", rule: OTHER_CODES[code] };
  if (api?.type && OTHER_CODES[api.type]) return { kind: "other", rule: OTHER_CODES[api.type] };
  for (const [re, label] of KNOWN_OTHER) if (re.test(message)) return { kind: "other", rule: label };
  return { kind: "other", rule: null };
}

/** One signature per kind of error, for the "unknown error" alert: digits, ids and quotes stripped, first 120 characters. */
export function errorSignature(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// ---- the Quota sub-tab ----

export const usageLimitAuditSchema = z.object({
  at: z.number(),
  event: z.enum(["run_paused", "global_paused", "probe", "resumed", "run_resumed", "lifted", "unknown_alert", "cron_skipped"]),
  by: z.string(),
  runId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  rule: z.string().nullable().optional(),
  evidence: z.string().nullable().optional(),
  resetAt: z.number().nullable().optional(),
  runs: z.array(z.string()).optional(),
  note: z.string().nullable().optional(),
});
export type UsageLimitAudit = z.infer<typeof usageLimitAuditSchema>;

export const heldRunSchema = z.object({
  runId: z.string(),
  blueprint: z.string(),
  stage: z.string().nullable(),
  agentId: z.string().nullable(),
  heldAt: z.number(),
  resumeAt: z.number().nullable(),
  /** "own match" (this run's worker hit the limit) or "global hold". */
  source: z.string(),
  rule: z.string().nullable(),
});

export const usageLimitStatusSchema = z.object({
  now: z.number(),
  /** The Blueprints setting usageLimit.enabled. */
  enabled: z.boolean(),
  /** clear: nothing held; run_holds: some runs hold on their own; paused: the whole Factory is held. */
  state: z.enum(["clear", "run_holds", "paused"]),
  since: z.number().nullable(),
  resumeAt: z.number().nullable(),
  provider: z.string().nullable(),
  rule: z.string().nullable(),
  evidence: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  runs: z.array(heldRunSchema),
  /** Agent ids of the held runs' workers (what an outside sweep needs). */
  agents: z.array(z.string()),
  notify: z.array(z.string()),
  /** Batches still to resume after a lift or a successful probe. */
  resuming: z.array(z.string()),
});
export type UsageLimitStatus = z.infer<typeof usageLimitStatusSchema>;

export const usageLimitStatusRpc = defineRpc({ name: "blueprints.usage_limit.status", input: z.object({}), output: usageLimitStatusSchema });
export const usageLimitAuditRpc = defineRpc({ name: "blueprints.usage_limit.audit", input: z.object({ limit: z.number().int().min(1).max(500).default(100) }), output: z.object({ entries: z.array(usageLimitAuditSchema) }) });
/** A person lifts the hold: held runs resume in staggered batches, without a probe first. */
export const usageLimitLiftRpc = defineRpc({ name: "blueprints.usage_limit.lift", input: z.object({ by: z.string().default("user") }), output: z.object({ ok: z.boolean(), message: z.string().nullable() }) });
