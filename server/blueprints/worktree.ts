import type { Paseo } from "../host";

/**
 * Run in the workspace's shell. The marker line carries the counts of uncommitted entries and of commits on a local branch (or HEAD)
 * that no remote has; every way this can go wrong prints ERR, never a count, so a broken check cannot read as "clean".
 */
export const PROBE_SCRIPT = [
  "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo FACTORY_PROBE ERR not-a-git-worktree; exit 0; }",
  "d=$(git status --porcelain 2>/dev/null) || { echo FACTORY_PROBE ERR git-status; exit 0; }",
  "u=$(git log HEAD --branches --not --remotes --oneline 2>/dev/null) || { echo FACTORY_PROBE ERR git-log; exit 0; }",
  'echo "FACTORY_PROBE OK $(printf %s "$d" | grep -c .) $(printf %s "$u" | grep -c .)"',
].join("\n");

export type Probe = { state: "clean" | "dirty" | "unknown"; detail: string };

/** The echoed script never matches: it has no "OK <n> <n>" or "ERR <word>" right after the marker. */
export function parseProbe(lines: readonly string[]): Probe {
  for (const line of lines) {
    const ok = /^FACTORY_PROBE OK (\d+) (\d+)\s*$/.exec(line.trim());
    if (ok) {
      const [dirty, unpushed] = [Number(ok[1]), Number(ok[2])];
      if (dirty === 0 && unpushed === 0) return { state: "clean", detail: "clean, nothing unpushed" };
      return { state: "dirty", detail: [dirty ? `${dirty} uncommitted file(s)` : "", unpushed ? `${unpushed} unpushed commit(s)` : ""].filter(Boolean).join(", ") };
    }
    const err = /^FACTORY_PROBE ERR ([a-z-]+)\s*$/.exec(line.trim());
    if (err) return { state: "unknown", detail: err[1] };
  }
  return { state: "unknown", detail: "no answer from the worktree" };
}

/** Run the probe in a short-lived terminal of the workspace. Anything unexpected is "unknown". */
export async function probeWorktree(paseo: Paseo, workspaceId: string, timeoutMs = 30_000): Promise<Probe> {
  let terminal: Awaited<ReturnType<Paseo["terminals"]["create"]>> | null = null;
  try {
    terminal = await paseo.terminals.create({ workspaceId, name: "factory-janitor", command: "sh", args: ["-c", PROBE_SCRIPT] });
    const until = Date.now() + timeoutMs;
    let last: Probe = { state: "unknown", detail: "no answer from the worktree" };
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      const captured = await terminal.capture({ stripAnsi: true });
      last = parseProbe(captured.lines);
      if (last.detail !== "no answer from the worktree") return last;
    }
    return last;
  } catch (error) {
    return { state: "unknown", detail: (error as Error).message };
  } finally {
    await terminal?.kill().catch(() => undefined);
  }
}
