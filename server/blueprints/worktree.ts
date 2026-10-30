import type { Paseo } from "../host";

/**
 * Runs a short shell script in a terminal of the workspace and returns the lines it printed, or the reason it did not answer
 * within `timeoutMs`. The terminal is killed in every case, also one that only comes up after the timeout.
 */
async function runInWorkspace(paseo: Paseo, workspaceId: string, name: string, script: string, timeoutMs: number): Promise<{ lines: string[] } | { error: string }> {
  let terminal: Awaited<ReturnType<Paseo["terminals"]["create"]>> | null = null;
  const until = Date.now() + timeoutMs;
  const left = () => Math.max(0, until - Date.now());
  const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), left()))]);
  const creating = paseo.terminals.create({ workspaceId, name, command: "sh", args: ["-c", `echo FACTORY_TRACE_BEGIN; ${script}; echo FACTORY_TRACE_END`] });
  try {
    terminal = await within(creating);
    while (left() > 0) {
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, left()))));
      const lines = (await within(terminal.capture({ stripAnsi: true }))).lines.map((l) => l.trimEnd());
      const end = lines.lastIndexOf("FACTORY_TRACE_END");
      const begin = lines.lastIndexOf("FACTORY_TRACE_BEGIN", end);
      if (end > begin && begin >= 0) return { lines: lines.slice(begin + 1, end).filter(Boolean) };
    }
    return { error: `${Math.round(timeoutMs / 1000)} s` };
  } catch (error) {
    // A terminal that comes up after the timeout (a pod that was resuming) is killed too, not left running in the pod.
    if (!terminal) void creating.then((late) => late.kill()).catch(() => undefined);
    return { error: (error as Error).message === "timeout" ? `${Math.round(timeoutMs / 1000)} s` : (error as Error).message };
  } finally {
    void terminal?.kill().catch(() => undefined);
  }
}

/**
 * A trace for the run history, never a gate: `git status --short` of the workspace, read in a short-lived terminal. A workspace is
 * archived whatever it holds (human rule 2026-10-28), so this only records what was thrown away. Every failure, and the timeout,
 * is an answer ("no answer"), not an error.
 */
export async function statusTrace(paseo: Paseo, workspaceId: string, timeoutMs = 5_000): Promise<string> {
  const out = await runInWorkspace(paseo, workspaceId, "factory-trace", "git status --short 2>&1", timeoutMs);
  if ("error" in out) return `no answer (${out.error})`;
  const files = out.lines;
  return files.length ? `${files.length} entries: ${files.slice(0, 10).join("; ")}${files.length > 10 ? "; …" : ""}` : "clean";
}

/**
 * Decision 12885996: a fresh worker's checkout answers git within `timeoutMs` (the worktree exists, git is not stuck on a lock or
 * a dead mount). `ok: false` says why; the engine retries the worker once, then stops the run instead of letting it hang.
 */
export async function worktreeCheck(paseo: Paseo, workspaceId: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const out = await runInWorkspace(paseo, workspaceId, "factory-worktree-check", "git rev-parse --is-inside-work-tree 2>&1 && git rev-parse --short HEAD 2>&1", timeoutMs);
  if ("error" in out) return { ok: false, detail: `git gave no answer (${out.error})` };
  if (out.lines[0] !== "true") return { ok: false, detail: `not a git worktree: ${out.lines.slice(0, 3).join("; ") || "no output"}` };
  return { ok: true, detail: `worktree at ${out.lines[1] ?? "?"}` };
}

/** A workspace whose agents ended their last turn longer ago than this may have an idle-suspended pod (Kubernetes Runtime). */
export const TRACE_FRESH_MS = 5 * 60_000;

/**
 * The last activity the Factory saw per agent (spawn, turn end), in memory: after a plugin restart nothing is known.
 * A trace opens a terminal, and on the Kubernetes Runtime a terminal in a suspended pod RESUMES it (tens of seconds, longer
 * than the 5 s budget): every trace of an idle worker answered "no answer (5 s)" and woke a pod that was archived right after.
 * So a workspace is traced only while one of its agents was active in the last TRACE_FRESH_MS.
 */
export class ActivityClock {
  private readonly last = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  touch(agentId: string): void {
    this.last.set(agentId, this.now());
  }
  /** Most recent activity of any of these agents, or null when none is known. */
  latest(agentIds: string[]): number | null {
    let out: number | null = null;
    for (const id of agentIds) {
      const at = this.last.get(id);
      if (at !== undefined && (out === null || at > out)) out = at;
    }
    return out;
  }
  forget(agentId: string): void {
    this.last.delete(agentId);
  }
}

/** `statusTrace` only for a workspace seen active lately; otherwise a note saying why it was not traced (no pod is woken). */
export async function freshTrace(trace: (workspaceId: string) => Promise<string>, workspaceId: string, lastActiveAt: number | null, now: number): Promise<string> {
  if (lastActiveAt === null) return "not traced (no recent activity known: the pod may be suspended and a trace would wake it)";
  const idle = now - lastActiveAt;
  if (idle > TRACE_FRESH_MS) return `not traced (idle ${Math.round(idle / 60_000)} min: the pod may be suspended and a trace would wake it)`;
  return trace(workspaceId);
}
