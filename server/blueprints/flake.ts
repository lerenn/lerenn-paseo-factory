import { DEFAULT_FLAKE_PATTERNS, DEFAULT_RETRO_FLAKE_PATTERNS, type FlakePattern } from "../../shared/blueprints/settings";

/**
 * Infrastructure failures of a worker: retried with a fresh turn and workspace, without using an attempt. First match names the
 * reason. The patterns are the Blueprints setting `flakes` (defaults: the Kubernetes Runtime's failures).
 */

/** The worker's provider session is gone (plugin disabled and enabled, pod recreated): resending to it can never work. */
export const SESSION_GONE = "provider session gone";

/** Built in, whatever the runtime: resending to a provider session that is gone can never work. */
const SESSION_GONE_PATTERN = /No conversation found with session ID/i;

interface Compiled {
  source: FlakeSettings | null;
  patterns: Array<[RegExp, string]>;
  startFailures: Set<string>;
  retro: RegExp | null;
}

type FlakeSettings = { patterns: FlakePattern[]; retroPatterns: string[] };

function compile(source: FlakeSettings | null): Compiled {
  const s = source ?? { patterns: DEFAULT_FLAKE_PATTERNS, retroPatterns: DEFAULT_RETRO_FLAKE_PATTERNS };
  const patterns: Array<[RegExp, string]> = [[SESSION_GONE_PATTERN, SESSION_GONE]];
  const startFailures = new Set<string>();
  for (const p of s.patterns) {
    const re = regex(p.pattern);
    if (!re) continue;
    patterns.push([re, p.label]);
    if (p.startFailure) startFailures.add(p.label);
  }
  const retro = s.retroPatterns.filter((p) => regex(p)).map((p) => `(?:${p})`);
  return { source, patterns, startFailures, retro: retro.length ? new RegExp(retro.join("|"), "i") : null };
}

function regex(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch (error) {
    console.error(`blueprints: flake pattern ${JSON.stringify(source)} is not a regular expression, skipped`, error);
    return null;
  }
}

let current = compile(null);

/** Use the Blueprints setting `flakes` (null: the defaults). Recompiled only when it changes. */
export function setFlakePatterns(settings: FlakeSettings | null | undefined): void {
  if ((settings ?? null) !== current.source) current = compile(settings ?? null);
}

/** The short reason when `text` (a failed turn's message, a spawn error) is an infrastructure failure, else null. */
export function flakeReason(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [re, label] of current.patterns) if (re.test(text)) return label;
  return null;
}

/** A flake reason that means the worker's workspace never came up (`startFailure` patterns). */
export function isStartFailure(reason: string | null | undefined): boolean {
  return !!reason && current.startFailures.has(reason);
}

/** The first flake worth naming in a retro (`flakes.retroPatterns`) in `text`, or null. */
export function retroFlake(text: string | null | undefined): string | null {
  return text && current.retro ? (current.retro.exec(text)?.[0] ?? null) : null;
}

/** "infra flakes ×3: OOMKilled / exit 137, pod did not start" (reasons in order of first appearance). */
export function flakeSummary(reasons: string[]): string {
  return `infra flakes ×${reasons.length}: ${[...new Set(reasons)].join(", ")}`;
}

/** The cluster refused a pod or sandbox for lack of quota (`exceeded quota: ... count/sandboxes ... used 24 limited 24`): it clears when an old workspace goes. */
export function isQuotaError(text: string | null | undefined): boolean {
  return !!text && /exceeded quota/i.test(text);
}

/** Wait before the n-th (1-based) retry of a start refused for quota: 1, 2, 4, 8 minutes, then 8 minutes each. */
export function quotaBackoffMs(n: number): number {
  return Math.min(8, 2 ** Math.max(0, n - 1)) * 60_000;
}

/**
 * The daemon was too loaded to answer in time: a plugin hook (`Plugin RPC timed out: kubernetes-runtime.hook`) or its own git
 * (`Git command timed out after 90000ms: git rev-parse --show-toplevel`). It passes once the load drops.
 */
export function isBusyError(text: string | null | undefined): boolean {
  return !!text && /Plugin RPC timed out|Git command timed out/i.test(text);
}

/** Back-off retries of a start that timed out on a busy daemon before the run pauses and asks a person. */
export const MAX_BUSY_RETRIES = 6;

/** A git command of the daemon that timed out (for example `git rev-parse --show-toplevel` after 90 s). */
export function isGitTimeout(text: string | null | undefined): boolean {
  return !!text && /Git command timed out/i.test(text);
}

/**
 * Git timeouts in a row at which the run pauses and alerts (one retry in between): a git that hangs twice rarely recovers by
 * waiting, and six back-off retries cost about 37 minutes on bp-7bc45f89 (decision f1cd49be).
 */
export const MAX_GIT_TIMEOUTS = 2;
