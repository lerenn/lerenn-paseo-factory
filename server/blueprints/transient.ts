/**
 * Transient vs permanent PR-facts read errors (the Factory's `gh` reads and a facts provider's alike). A transient one (GitHub 5xx,
 * 429 or a secondary rate limit, a network error, a timeout) says nothing about the PR: a wait keeps waiting and reads again later,
 * a person's action (resume, a gate answer) is retried a few times and then refused with "GitHub unavailable, try again", and no
 * run fails for it (bp-98295f48 failed at wait-queue on "gh: HTTP 500" while both its PRs had merged). Anything else (404, 401,
 * 403 that is not a rate limit, a malformed URL or answer) is permanent and keeps its old effect.
 */

/** The PR facts could not be read for a transient reason, after the quick retries: nothing was changed, try again. */
export class GitHubUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(`GitHub unavailable (${errorMessage(cause)}); nothing was changed, try again in a minute.`);
  }
}

const errorMessage = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

const TRANSIENT_TEXT = [
  /secondary rate limit/i,
  /rate limit (exceeded|reached)|API rate limit|abuse detection/i,
  /\bHTTP\s*(429|5\d\d)\b/i,
  /\b(429|5\d\d)\s+(Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)/i,
  /\b(status|code)\s*[:=]?\s*(429|5\d\d)\b/i,
  /Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Server Error/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network (error|is unreachable)|fetch failed|connection (reset|refused|closed)|TLS handshake timeout|i\/o timeout/i,
  /timed? ?out|timeout|deadline exceeded/i,
  /something went wrong while executing your query|We couldn't respond to your request in time/i,
];

/** A 404, an auth refusal or a malformed URL: the same read will not do better later. */
const PERMANENT_TEXT = [/\b(401|404)\b/, /not found|Could not resolve/i, /Bad credentials|authentication|requires authentication/i, /not a GitHub pull request URL|malformed/i];

/** True when retrying the same read later may well succeed. */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof GitHubUnavailableError) return true;
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown; killed?: unknown; transient?: unknown; cause?: unknown; message?: unknown };
  if (e.transient === true) return true;
  if (e.transient === false) return false;
  const message = errorMessage(error);
  const status = Number(e.status ?? e.statusCode);
  if (Number.isFinite(status) && status > 0) {
    if (status === 429 || (status >= 500 && status <= 599)) return true;
    // GitHub answers a secondary rate limit with a 403.
    if (status === 403) return /rate limit|abuse/i.test(message);
    return false;
  }
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  if (e.killed === true) return true; // the `gh` child was killed by its timeout
  if (/rate limit|abuse detection/i.test(message)) return true;
  if (/Could not resolve host|error connecting to|dial tcp|no such host/i.test(message)) return true; // DNS or connect, not a missing PR
  if (PERMANENT_TEXT.some((r) => r.test(message))) return false;
  if (TRANSIENT_TEXT.some((r) => r.test(message))) return true;
  return e.cause !== undefined && e.cause !== error ? isTransientError(e.cause) : false;
}

/** Back-off of a polling wait after `n` transient failures in a row (1-based): 30 s, 1, 2, 4, 8, then 10 min. */
export function transientBackoffMs(n: number): number {
  return Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, n - 1));
}

/** A transient streak this long opens one notice for a person; the wait still goes on. */
export const TRANSIENT_NOTICE_MS = 30 * 60_000;

/** Tries of a person-facing read (resume, a gate answer) and the pauses between them. */
export const QUICK_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * `fn`, retried on a transient error after each of `delays` (so `delays.length + 1` tries). A permanent error is thrown at once;
 * a transient one that outlasts the tries is thrown as a `GitHubUnavailableError`.
 */
export async function withQuickRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, delays: number[] = QUICK_RETRY_DELAYS_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientError(error)) throw error;
      if (i >= delays.length) throw error instanceof GitHubUnavailableError ? error : new GitHubUnavailableError(error);
      await sleep(delays[i]);
    }
  }
}
