import { describe, expect, it } from "vitest";
import { GitHubUnavailableError, isTransientError, transientBackoffMs, withQuickRetry } from "./transient";

describe("isTransientError", () => {
  it.each([
    "gh: HTTP 500",
    "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
    "HTTP 503: Service Unavailable",
    "gh: HTTP 504",
    "HTTP 429: Too Many Requests",
    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    "HTTP 403: API rate limit exceeded for user ID 1.",
    "read ECONNRESET",
    "Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host",
    "error connecting to api.github.com",
    "gh timed out: ",
    "net/http: TLS handshake timeout",
    "Something went wrong while executing your query. This may be the result of a timeout",
  ])("transient: %s", (message) => expect(isTransientError(new Error(message))).toBe(true));

  it.each([
    "gh: HTTP 404: Not Found",
    "GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)",
    "HTTP 401: Bad credentials",
    "HTTP 403: Resource not accessible by integration",
    "not a GitHub pull request URL: https://example.com/x",
    "the facts provider gave malformed facts for https://github.com/a/b/pull/1",
    "boom",
  ])("permanent: %s", (message) => expect(isTransientError(new Error(message))).toBe(false));

  it("reads a structured status or errno first (a provider's Octokit error)", () => {
    expect(isTransientError(Object.assign(new Error("request failed"), { status: 502 }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("request failed"), { status: 429 }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("You have exceeded a secondary rate limit"), { status: 403 }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("Forbidden"), { status: 403 }))).toBe(false);
    expect(isTransientError(Object.assign(new Error("Server Error"), { status: 404 }))).toBe(false);
    expect(isTransientError(Object.assign(new Error("socket"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { killed: true }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { transient: true }))).toBe(true);
    expect(isTransientError(new Error("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }))).toBe(true);
  });
});

describe("transientBackoffMs", () => {
  it("30 s, 1, 2, 4, 8, then 10 min", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(transientBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });
});

describe("withQuickRetry", () => {
  const noSleep = async () => {};

  it("retries a transient error and returns the first answer", async () => {
    let n = 0;
    const out = await withQuickRetry(async () => (++n < 3 ? Promise.reject(new Error("gh: HTTP 500")) : "ok"), noSleep);
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("gives up after three tries with GitHubUnavailableError", async () => {
    let n = 0;
    const slept: number[] = [];
    const call = withQuickRetry(async () => (n++, Promise.reject(new Error("gh: HTTP 503"))), async (ms) => void slept.push(ms));
    await expect(call).rejects.toBeInstanceOf(GitHubUnavailableError);
    await expect(call).rejects.toThrow(/GitHub unavailable \(gh: HTTP 503\).*try again/);
    expect(n).toBe(3);
    expect(slept).toEqual([1_000, 3_000]);
  });

  it("throws a permanent error at once", async () => {
    let n = 0;
    await expect(withQuickRetry(async () => (n++, Promise.reject(new Error("HTTP 404: Not Found"))), noSleep)).rejects.toThrow("HTTP 404");
    expect(n).toBe(1);
  });
});
