import type { Issue } from "../host";

/**
 * Which open issues to tell the Supervisor about now: new ones, and ones told long ago and still open.
 * `told` maps issue key to the last time it was told; closed issues are forgotten.
 */
export function nextDigest(issues: readonly Issue[], told: Record<string, number>, now: number, repeatMs: number): { send: Issue[]; told: Record<string, number> } {
  const open = new Set(issues.map((i) => i.key));
  const next: Record<string, number> = {};
  for (const [key, at] of Object.entries(told)) if (open.has(key)) next[key] = at;
  const send: Issue[] = [];
  for (const issue of issues) {
    const last = next[issue.key];
    if (last === undefined || now - last >= repeatMs) {
      send.push(issue);
      next[issue.key] = now;
    }
  }
  return { send, told: next };
}

export function digestMessage(send: readonly Issue[]): string {
  return (
    `Factory digest (${send.length} issue${send.length === 1 ? "" : "s"} for you):\n` +
    send.map((i) => `- ${i.text}`).join("\n") +
    `\nAct with your tools (blueprint_abort / blueprint_retry / blueprint_resume, extension_restart, lease and warden tools), and ask the user through inbox_ask when a person must decide.`
  );
}
