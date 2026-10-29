import type { Paseo } from "../host";

/**
 * A trace for the run history, never a gate: `git status --short` of the workspace, read in a short-lived terminal. A workspace is
 * archived whatever it holds (human rule 2026-10-28), so this only records what was thrown away. Every failure, and the timeout,
 * is an answer ("no answer"), not an error.
 */
export async function statusTrace(paseo: Paseo, workspaceId: string, timeoutMs = 5_000): Promise<string> {
  let terminal: Awaited<ReturnType<Paseo["terminals"]["create"]>> | null = null;
  const until = Date.now() + timeoutMs;
  const left = () => Math.max(0, until - Date.now());
  const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), left()))]);
  try {
    terminal = await within(paseo.terminals.create({ workspaceId, name: "factory-trace", command: "sh", args: ["-c", "echo FACTORY_TRACE_BEGIN; git status --short 2>&1; echo FACTORY_TRACE_END"] }));
    while (left() > 0) {
      await new Promise((r) => setTimeout(r, 500));
      const lines = (await within(terminal.capture({ stripAnsi: true }))).lines.map((l) => l.trimEnd());
      const end = lines.lastIndexOf("FACTORY_TRACE_END");
      const begin = lines.lastIndexOf("FACTORY_TRACE_BEGIN", end);
      if (end > begin && begin >= 0) {
        const files = lines.slice(begin + 1, end).filter(Boolean);
        return files.length ? `${files.length} entries: ${files.slice(0, 10).join("; ")}${files.length > 10 ? "; …" : ""}` : "clean";
      }
    }
    return "no answer (5 s)";
  } catch (error) {
    return `no answer (${(error as Error).message})`;
  } finally {
    void terminal?.kill().catch(() => undefined);
  }
}
