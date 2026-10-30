// Per-turn spend from what Paseo reports, and the one-time rewrite of a spend.json written before (decision 6e558c38).
// Self-contained (node builtins only, erasable TypeScript) so it also runs as a CLI on the host, outside the daemon:
//   node --experimental-strip-types spend-recompute.ts <spend.json> [--warden <warden.json>] [--run <run id>]... [--now <epoch ms>]
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The fields of a spend record this file reads and writes (spend.ts has the full type). */
export interface SpendRow {
  agentId: string;
  turnId: string;
  at: number;
  role: string | null;
  run: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** This turn's cost. On a record without `costTotalUsd` (written before decision 6e558c38) it is the session's running total. */
  costUsd: number;
  /** The session's running total Paseo reported after the turn (Claude's `total_cost_usd`); costUsd is then the delta. */
  costTotalUsd?: number;
}

/** What the next turn of an agent is compared with. */
export interface LastSample {
  total: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * One turn of an agent against its previous one. The cost Paseo reports is the session's running total: the turn's
 * share is the rise since the previous record of the agent. The first record counts whole, and so does a value below
 * the previous one (a new session: /clear, a fresh session after a restart). Tokens are per turn (Claude's result
 * `usage`, Codex's last usage) and count as reported. The same running total with the same tokens under another turn id
 * is the same turn read twice: a duplicate.
 */
export function stepSpend(prev: LastSample | undefined, s: LastSample): { duplicate: boolean; costUsd: number } {
  if (prev && prev.total === s.total && prev.inputTokens === s.inputTokens && prev.cachedInputTokens === s.cachedInputTokens && prev.outputTokens === s.outputTokens) {
    return { duplicate: true, costUsd: 0 };
  }
  return { duplicate: false, costUsd: !prev || s.total < prev.total ? s.total : round(s.total - prev.total) };
}

export const sampleOf = (r: SpendRow): LastSample => ({
  total: r.costTotalUsd ?? r.costUsd,
  inputTokens: r.inputTokens,
  cachedInputTokens: r.cachedInputTokens,
  outputTokens: r.outputTokens,
});

/**
 * Records in their stored order (oldest first) with per-turn costs: an old record (no costTotalUsd) gets its delta and
 * its running total; a new one is kept as written. Duplicates are dropped. Idempotent: its output is its own fixed point.
 */
export function normalizeSpend<T extends SpendRow>(records: readonly T[]): { records: T[]; last: Map<string, LastSample>; dropped: number } {
  const last = new Map<string, LastSample>();
  const out: T[] = [];
  let dropped = 0;
  for (const r of records) {
    const s = sampleOf(r);
    const step = stepSpend(last.get(r.agentId), s);
    if (step.duplicate) {
      dropped++;
      continue;
    }
    last.set(r.agentId, s);
    out.push(r.costTotalUsd === undefined ? { ...r, costUsd: step.costUsd, costTotalUsd: s.total } : r);
  }
  return { records: out, last, dropped };
}

/** Spend role of an anyshift-releaser agent, which has no paseo.factory.role: Dev QA by its label, a job by its title. */
export function releaseRole(labels: Record<string, string>, title: string | null | undefined): string | null {
  if (labels["releaser.qa"]) return "Dev QA";
  if (labels["releaser.job"]) return releaseRoleOfTitle(title) ?? "Release";
  return null;
}

/** The releaser titles its agents "Release: cut", "Release: pin <env>", "Release: migration" and "Dev QA: <item>". */
export function releaseRoleOfTitle(title: string | null | undefined): string | null {
  const t = title?.trim() ?? "";
  if (/^Dev QA:/.test(t)) return "Dev QA";
  const m = /^Release: (cut|migration|pin (dev|stg|prd))$/.exec(t);
  if (!m) return null;
  if (m[2]) return `Pin ${m[2]}`;
  return m[1] === "cut" ? "Release cut" : "Release migration";
}

export interface RecomputeReport {
  backup: string;
  changed: boolean;
  records: { before: number; after: number; duplicates: number; relabelled: number };
  window: { days: number; before: number; after: number };
  runs: { run: string; before: number; after: number }[];
}

const sum = (rows: readonly SpendRow[], keep: (r: SpendRow) => boolean) => round(rows.filter(keep).reduce((n, r) => n + r.costUsd, 0));

/**
 * Rewrites a spend.json with per-turn costs (normalizeSpend), and gives release agents with no role theirs from the
 * titles the Warden kept (warden.json `agents[id].title`). Writes a timestamped backup first (never overwritten), then
 * the file atomically, only when something changed. Running it again changes nothing.
 */
export function recomputeSpendFile(file: string, o: { wardenFile?: string | null; runs?: string[]; now?: number; days?: number } = {}): RecomputeReport {
  const now = o.now ?? Date.now();
  const days = o.days ?? 30;
  const text = readFileSync(file, "utf8");
  const before = (JSON.parse(text).records ?? []) as SpendRow[];
  const backup = `${file}.bak-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, text, { mode: 0o600, flag: "wx" });

  const titles = new Map<string, string>();
  if (o.wardenFile && existsSync(o.wardenFile)) {
    const agents = (JSON.parse(readFileSync(o.wardenFile, "utf8")).agents ?? {}) as Record<string, { title?: string | null }>;
    for (const [id, a] of Object.entries(agents)) if (a?.title) titles.set(id, a.title);
  }
  const { records: normalized, dropped } = normalizeSpend(before);
  let relabelled = 0;
  const after = normalized.map((r) => {
    if (r.role) return r;
    const role = releaseRoleOfTitle(titles.get(r.agentId));
    if (!role) return r;
    relabelled++;
    return { ...r, role };
  });

  const changed = JSON.stringify(after) !== JSON.stringify(before);
  if (changed) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ records: after }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
  const since = now - days * 24 * 3600 * 1000;
  return {
    backup,
    changed,
    records: { before: before.length, after: after.length, duplicates: dropped, relabelled },
    window: { days, before: sum(before, (r) => r.at >= since), after: sum(after, (r) => r.at >= since) },
    runs: (o.runs ?? []).map((run) => ({ run, before: sum(before, (r) => r.run === run), after: sum(after, (r) => r.run === run) })),
  };
}

export function formatReport(r: RecomputeReport): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return [
    `backup: ${r.backup}`,
    `records: ${r.records.before} -> ${r.records.after} (${r.records.duplicates} duplicates dropped, ${r.records.relabelled} release agents given a role)${r.changed ? "" : " (unchanged, file not rewritten)"}`,
    `${r.window.days}-day total: ${usd(r.window.before)} -> ${usd(r.window.after)}`,
    ...r.runs.map((x) => `run ${x.run}: ${usd(x.before)} -> ${usd(x.after)}`),
  ].join("\n");
}

export function cli(argv: string[]): string {
  const args = [...argv];
  let file: string | null = null;
  let wardenFile: string | null | undefined;
  let now: number | undefined;
  const runs: string[] = [];
  while (args.length) {
    const a = args.shift()!;
    if (a === "--warden") wardenFile = args.shift() ?? null;
    else if (a === "--run") runs.push(args.shift() ?? "");
    else if (a === "--now") now = Number(args.shift());
    else if (!file) file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!file) throw new Error("usage: spend-recompute.ts <spend.json> [--warden <warden.json>] [--run <run id>]... [--now <epoch ms>]");
  // The Warden's state sits next to spend.json in the Factory's data folder.
  if (wardenFile === undefined) wardenFile = path.join(path.dirname(file), "warden.json");
  return formatReport(recomputeSpendFile(file, { wardenFile, runs: runs.filter(Boolean), now }));
}

// Run as a script (never when the daemon loads the plugin: its argv[1] is not this file).
if (/spend-recompute\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  try {
    console.log(cli(process.argv.slice(2)));
  } catch (error) {
    console.error(String((error as Error)?.message ?? error));
    process.exitCode = 1;
  }
}
