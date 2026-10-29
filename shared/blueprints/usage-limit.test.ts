import { describe, expect, it } from "vitest";
import { classifyUsageLimit, errorSignature, parseResetTime } from "./usage-limit";

// 2026-10-29T14:00:00Z
const NOW = Date.UTC(2026, 9, 29, 14, 0, 0);

// Anchored fixtures in the providers' documented wording. No real terminal usage-limit error was captured on the lab daemons
// when this was written (2026-10-29); each real one seen later is added here with its source (agent id, date), and an error
// the classifier does not know raises one alert per signature so the list grows from evidence.
const POSITIVE: Array<{ name: string; failure: { message: string; code?: string; status?: number }; rule: string; resetAt: number | null }> = [
  { name: "Claude Code epoch form", failure: { message: "Claude AI usage limit reached|1793372460" }, rule: "claude-usage-limit-epoch", resetAt: 1793372460_000 },
  {
    name: "Claude Code reset clock with zone",
    failure: { message: "Claude usage limit reached. Your limit will reset at 7pm (Europe/Paris)." },
    rule: "claude-limit-reached",
    resetAt: Date.UTC(2026, 9, 29, 18, 0), // CET (UTC+1) after the DST change of 2026-10-25
  },
  { name: "Claude Code 5-hour limit", failure: { message: "5-hour limit reached ∙ resets 3pm" }, rule: "claude-limit-reached", resetAt: Date.UTC(2026, 9, 29, 15, 0) },
  { name: "Claude Code hit your limit, UTC", failure: { message: "You've hit your limit · resets 1:30pm (UTC)" }, rule: "claude-limit-reached", resetAt: Date.UTC(2026, 9, 30, 13, 30) },
  { name: "Claude Code weekly limit with a date", failure: { message: "Weekly limit reached ∙ resets Oct 31, 9am (UTC)" }, rule: "claude-limit-reached", resetAt: Date.UTC(2026, 9, 31, 9, 0) },
  { name: "Claude Code limit without reset", failure: { message: "Claude AI usage limit reached" }, rule: "claude-limit-reached", resetAt: null },
  { name: "Codex try again in", failure: { message: "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 5 minutes." }, rule: "codex-usage-limit", resetAt: NOW + 2 * 3600_000 + 5 * 60_000 },
  { name: "Codex try again at", failure: { message: "■ You've hit your usage limit. Try again at 4:04 PM." }, rule: "codex-usage-limit", resetAt: Date.UTC(2026, 9, 29, 16, 4) },
  { name: "structured code rate_limit_error", failure: { message: "Request failed", code: "rate_limit_error" }, rule: "code:rate_limit_error", resetAt: null },
  { name: "structured code usage_limit_reached", failure: { message: "The usage limit has been reached", code: "usage_limit_reached" }, rule: "code:usage_limit_reached", resetAt: null },
  { name: "structured status 429", failure: { message: "Too Many Requests", status: 429 }, rule: "status:429", resetAt: null },
  {
    name: "terminal API Error 429 with JSON type",
    failure: { message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}' },
    rule: "api-error:rate_limit_error",
    resetAt: null,
  },
];

const NEGATIVE: Array<{ name: string; failure: { message: string; code?: string; status?: number }; rule: string | null }> = [
  { name: "529 overloaded", failure: { message: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }, rule: "overloaded" },
  { name: "overloaded code", failure: { message: "Overloaded", code: "overloaded_error" }, rule: "overloaded" },
  { name: "500", failure: { message: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' }, rule: "server error" },
  { name: "503 overloaded text", failure: { message: "503 overloaded" }, rule: "overloaded" },
  { name: "network", failure: { message: "fetch failed: ECONNRESET" }, rule: "network" },
  { name: "DNS", failure: { message: "getaddrinfo EAI_AGAIN api.anthropic.com" }, rule: "network" },
  { name: "auth", failure: { message: "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}" }, rule: "auth" },
  { name: "auth code", failure: { message: "Invalid API key · Please run /login", code: "authentication_failed" }, rule: "auth" },
  { name: "context too long", failure: { message: "Prompt is too long" }, rule: "context too long" },
  { name: "tool / permission", failure: { message: "Permission to use Bash has been denied." }, rule: "tool or permission" },
  { name: "Kubernetes quota", failure: { message: "exceeded quota: agents-quota, requested: count/sandboxes=1, used: count/sandboxes=24, limited: count/sandboxes=24" }, rule: "kubernetes quota" },
  { name: "limit in passing", failure: { message: "Bash failed: grep 'usage limit reached' found 3 matches in the rate limiter test (429 expected)" }, rule: null },
  { name: "a test log line", failure: { message: "expected status 429 but got 200 in TestRateLimit" }, rule: null },
  { name: "Codex review comment", failure: { message: "Task failed: PR comment says You have reached your Codex usage limits for code reviews." }, rule: null },
  { name: "work failure", failure: { message: "Tests failed: 3 of 120" }, rule: null },
];

describe("classifyUsageLimit", () => {
  for (const p of POSITIVE) {
    it(`is a usage limit: ${p.name}`, () => {
      const out = classifyUsageLimit(p.failure, NOW);
      expect(out).toMatchObject({ kind: "usage_limit", rule: p.rule, resetAt: p.resetAt });
      if (out.kind === "usage_limit") expect(out.evidence.length).toBeLessThanOrEqual(300);
    });
  }
  for (const n of NEGATIVE) {
    it(`is not a usage limit: ${n.name}`, () => {
      expect(classifyUsageLimit(n.failure, NOW)).toEqual({ kind: "other", rule: n.rule });
    });
  }

  it("ignores a reset time in the past or more than 7 days ahead", () => {
    expect(classifyUsageLimit({ message: "Claude AI usage limit reached|1000000000" }, NOW)).toMatchObject({ kind: "usage_limit", resetAt: null });
    expect(classifyUsageLimit({ message: "You've hit your usage limit. Try again in 9 days." }, NOW)).toMatchObject({ kind: "usage_limit", resetAt: null });
  });

  it("reads a clock time without a zone in the zone given", () => {
    expect(classifyUsageLimit({ message: "5-hour limit reached ∙ resets 3pm" }, NOW, "Europe/Paris")).toMatchObject({ resetAt: Date.UTC(2026, 9, 29, 14, 0) + 24 * 3600_000 });
  });
});

describe("parseResetTime", () => {
  it("reads 24-hour clocks, durations, and refuses bare numbers", () => {
    expect(parseResetTime("at 15:00 (UTC)", NOW)).toBe(Date.UTC(2026, 9, 29, 15, 0));
    expect(parseResetTime("in 30 minutes", NOW)).toBe(NOW + 30 * 60_000);
    expect(parseResetTime("in 3", NOW)).toBeNull();
    expect(parseResetTime("at 15 (Not/AZone)", NOW)).toBeNull();
  });
});

describe("errorSignature", () => {
  it("groups errors that differ only by numbers and ids", () => {
    expect(errorSignature("Session 0a1b2c3d-1111-2222-3333-444455556666 failed after 12 s")).toBe(errorSignature("Session 9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff failed after 3 s"));
  });
});
