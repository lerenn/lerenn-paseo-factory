import type { Paseo } from "../host";

/** The workspace did not come up (no terminal could be opened in it) within the boot budget: nothing was probed. */
export type NotUp = { notUp: string };

/**
 * Runs a short shell script in a terminal of the workspace and returns the lines it printed, or the reason it did not answer
 * within `timeoutMs`. The terminal is killed in every case, also one that only comes up after the timeout.
 *
 * Without `bootMs`, one budget covers opening the terminal and the script. With `bootMs`, the workspace has its own budget to
 * come up (a cold Kubernetes Runtime pod takes minutes to boot with the warm pool off): a failed open is retried within it, and
 * `timeoutMs` only starts once the script's first line (`FACTORY_TRACE_BEGIN`) shows, i.e. once the shell really runs in the
 * workspace. An open terminal is not enough (bp-a221435b): `terminals.create` answers at once while the shell behind it only
 * starts when the pod is ready, so a 60 s counted from the open still ran from spawn. A workspace whose script never started
 * returns `notUp`, which is not an answer of the script.
 */
async function runInWorkspace(
  paseo: Paseo,
  workspaceId: string,
  name: string,
  script: string,
  timeoutMs: number,
  bootMs?: number,
): Promise<{ lines: string[] } | { error: string } | NotUp> {
  let terminal: Awaited<ReturnType<Paseo["terminals"]["create"]>> | null = null;
  let until = Date.now() + (bootMs ?? timeoutMs);
  // Without a boot budget the script counts as started at once; with one, `until` is the boot deadline until its first line shows.
  let started = bootMs === undefined;
  const left = () => Math.max(0, until - Date.now());
  const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), left()))]);
  const notUp = (why: string) => ({ notUp: `workspace not up after ${Math.round(bootMs! / 1000)} s${why ? ` (${why})` : ""}` });
  const neverRan = "the terminal opened but its shell never started";
  const open = () => paseo.terminals.create({ workspaceId, name, command: "sh", args: ["-c", `echo FACTORY_TRACE_BEGIN; ${script}; echo FACTORY_TRACE_END`] });
  let creating = open();
  try {
    if (bootMs === undefined) terminal = await within(creating);
    else {
      let lastError = "";
      while (!terminal) {
        try {
          terminal = await within(creating);
        } catch (error) {
          if ((error as Error).message === "timeout") return notUp(lastError);
          lastError = (error as Error).message;
          await new Promise((r) => setTimeout(r, Math.min(BOOT_RETRY_MS, left())));
          if (left() <= 0) return notUp(lastError);
          creating = open();
        }
      }
    }
    while (left() > 0) {
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, left()))));
      let lines: string[];
      try {
        lines = (await within(terminal.capture({ stripAnsi: true }))).lines.map((l) => l.trimEnd());
      } catch (error) {
        // A terminal whose pod is still booting may not be readable yet: not an answer while the boot budget lasts.
        if (started || (error as Error).message === "timeout") throw error;
        continue;
      }
      const end = lines.lastIndexOf("FACTORY_TRACE_END");
      const begin = end >= 0 ? lines.lastIndexOf("FACTORY_TRACE_BEGIN", end) : lines.lastIndexOf("FACTORY_TRACE_BEGIN");
      if (end > begin && begin >= 0) return { lines: lines.slice(begin + 1, end).filter(Boolean) };
      if (!started && begin >= 0) {
        // The shell runs in the workspace now (the pod is up): the script's own budget starts here.
        started = true;
        until = Date.now() + timeoutMs;
      }
    }
    return started ? { error: `${Math.round(timeoutMs / 1000)} s` } : notUp(neverRan);
  } catch (error) {
    if ((error as Error).message === "timeout" && !started) return notUp(neverRan);
    return { error: (error as Error).message === "timeout" ? `${Math.round(timeoutMs / 1000)} s` : (error as Error).message };
  } finally {
    // A terminal that comes up after the timeout (a pod that was resuming) is killed too, not left running in the pod.
    if (terminal) void terminal.kill().catch(() => undefined);
    else void creating.then((late) => late.kill()).catch(() => undefined);
  }
}

/** Pause between two attempts to open a terminal in a workspace that is still booting. */
const BOOT_RETRY_MS = 5_000;

/**
 * A trace for the run history, never a gate: `git status --short` of the workspace, read in a short-lived terminal. A workspace is
 * archived whatever it holds (human rule 2026-10-28), so this only records what was thrown away. Every failure, and the timeout,
 * is an answer ("no answer"), not an error.
 */
export async function statusTrace(paseo: Paseo, workspaceId: string, timeoutMs = 5_000): Promise<string> {
  const out = await runInWorkspace(paseo, workspaceId, "factory-trace", "git status --short 2>&1", timeoutMs);
  if (!("lines" in out)) return `no answer (${"error" in out ? out.error : out.notUp})`;
  const files = out.lines;
  return files.length ? `${files.length} entries: ${files.slice(0, 10).join("; ")}${files.length > 10 ? "; …" : ""}` : "clean";
}

/**
 * Decision 12885996: a fresh worker's checkout answers git within `timeoutMs` (the worktree exists, git is not stuck on a lock or
 * a dead mount). `ok: false` says why; the engine retries the worker once, then stops the run instead of letting it hang.
 *
 * `timeoutMs` starts once the workspace is up (the probe's shell printed its first line in it), not at spawn and not when the
 * terminal opened: a cold pod may take minutes to boot, and that is not a git stall. A workspace still not up after `bootMs` is
 * `unchecked`: the probe never ran, so it is not a failure. The probe takes no optional lock (GIT_OPTIONAL_LOCKS=0).
 */
export async function worktreeCheck(
  paseo: Paseo,
  workspaceId: string,
  timeoutMs: number,
  bootMs = WORKTREE_BOOT_GRACE_MS,
): Promise<{ ok: boolean; detail: string; unchecked?: boolean }> {
  const out = await runInWorkspace(paseo, workspaceId, "factory-worktree-check", "export GIT_OPTIONAL_LOCKS=0; git rev-parse --is-inside-work-tree 2>&1 && git rev-parse --short HEAD 2>&1", timeoutMs, bootMs);
  if ("notUp" in out) return { ok: false, unchecked: true, detail: out.notUp };
  if ("error" in out) return { ok: false, detail: `git gave no answer (${out.error})` };
  if (out.lines[0] !== "true") return { ok: false, detail: `not a git worktree: ${out.lines.slice(0, 3).join("; ") || "no output"}` };
  return { ok: true, detail: `worktree at ${out.lines[1] ?? "?"}` };
}

/** Default time a fresh worker's workspace has to come up (pod scheduled and booted) before its `worktree_check` starts. */
export const WORKTREE_BOOT_GRACE_MS = 10 * 60_000;

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
