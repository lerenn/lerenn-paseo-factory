/** Infrastructure failures of a worker: retried with a fresh turn and pod, without using an attempt. First match names the reason. */
/** The worker's provider session is gone (plugin disabled and enabled, pod recreated): resending to it can never work. */
export const SESSION_GONE = "provider session gone";

const PATTERNS: Array<[RegExp, string]> = [
  [/No conversation found with session ID/i, SESSION_GONE],
  [/exit(?:ed)?(?: with)?(?: code)?[ :=]*137\b|OOMKilled|\bSIGKILL\b/i, "OOMKilled / exit 137"],
  [/exit(?:ed)?(?: with)?(?: code)?[ :=]*143\b|\bSIGTERM\b/i, "exit 143 (SIGTERM)"],
  [/could not write bridge\.mjs/i, "bridge.mjs not written"],
  [/could not start the pod|pod[^.\n]{0,60}(?:did not start|failed to start)/i, "pod did not start"],
  [/container not found/i, "container not found"],
  [/channel ended/i, "channel ended"],
  [/pod[^.\n]{0,60}not ready|not ready after \d+ ?s/i, "pod not ready"],
  [/pod[^.\n]{0,40}(?:evicted|replaced|failed|deleted)|\bevicted\b|worker gone/i, "pod failed / evicted / replaced"],
];

/** The short reason when `text` (a failed turn's message, a spawn error) is an infrastructure failure, else null. */
export function flakeReason(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [re, label] of PATTERNS) if (re.test(text)) return label;
  return null;
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
