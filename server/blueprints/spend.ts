import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeSpend, sampleOf, stepSpend, type LastSample } from "./spend-recompute";

export interface SpendRecord {
  agentId: string;
  turnId: string;
  at: number;
  role: string | null;
  run: string | null;
  blueprint: string | null;
  stage: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** This turn's cost: the rise of the session's running total since the agent's previous record (spend-recompute.ts). */
  costUsd: number;
  /** The session's running total Paseo reported after the turn. Absent on records written before: costUsd was that total. */
  costTotalUsd?: number;
}

/** A turn as Paseo reports it: the session's running total, not yet this turn's share. */
export type SpendSample = Omit<SpendRecord, "costUsd" | "costTotalUsd"> & { costTotalUsd: number };

export interface SpendTotals {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SpendReport {
  total: SpendTotals;
  byRun: ({ key: string; blueprint: string | null } & SpendTotals)[];
  byRole: ({ key: string } & SpendTotals)[];
  byDay: ({ key: string } & SpendTotals)[];
}

const MAX_RECORDS = 50_000;

/**
 * Usage of the agents the Factory spawned, one record per turn. Paseo's `lastUsage` carries the session's running cost
 * (and per-turn tokens): each record keeps that total and the turn's share of it. Records written before are read
 * with the same rule in memory; spend-recompute.ts rewrites the file once.
 */
export class SpendStore {
  private records: SpendRecord[] = [];
  private readonly seen = new Set<string>();
  /** Each agent's last recorded turn, to compute the next one's share. */
  private last = new Map<string, LastSample>();

  constructor(private readonly file: string | null) {
    let stored: SpendRecord[] = [];
    if (file) {
      try {
        stored = JSON.parse(readFileSync(file, "utf8")).records ?? [];
      } catch {
        stored = [];
      }
    }
    ({ records: this.records, last: this.last } = normalizeSpend(stored));
    for (const r of this.records) this.seen.add(`${r.agentId}:${r.turnId}`);
  }

  /** False for a turn already recorded, or the same usage read again under another turn id. */
  add(sample: SpendSample): boolean {
    const key = `${sample.agentId}:${sample.turnId}`;
    if (this.seen.has(key)) return false;
    const s = sampleOf({ ...sample, costUsd: sample.costTotalUsd });
    const step = stepSpend(this.last.get(sample.agentId), s);
    if (step.duplicate) return false;
    this.seen.add(key);
    this.last.set(sample.agentId, s);
    this.records.push({ ...sample, costUsd: step.costUsd });
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    this.save();
    return true;
  }

  all(): SpendRecord[] {
    return this.records;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ records: this.records }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

const zero = (): SpendTotals => ({ turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 });
function add(t: SpendTotals, r: SpendRecord): void {
  t.turns += 1;
  t.inputTokens += r.inputTokens;
  t.cachedInputTokens += r.cachedInputTokens;
  t.outputTokens += r.outputTokens;
  t.costUsd += r.costUsd;
}

/** Aggregate per blueprint run, per role and per day (UTC). */
export function aggregate(records: readonly SpendRecord[], sinceMs = 0): SpendReport {
  const total = zero();
  const runs = new Map<string, { blueprint: string | null } & SpendTotals>();
  const roles = new Map<string, SpendTotals>();
  const days = new Map<string, SpendTotals>();
  for (const r of records) {
    if (r.at < sinceMs) continue;
    add(total, r);
    const run = r.run ?? "(no run)";
    if (!runs.has(run)) runs.set(run, { blueprint: r.blueprint, ...zero() });
    add(runs.get(run)!, r);
    const role = r.role ?? "(no role)";
    if (!roles.has(role)) roles.set(role, zero());
    add(roles.get(role)!, r);
    const day = new Date(r.at).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, zero());
    add(days.get(day)!, r);
  }
  const rows = <T extends SpendTotals>(m: Map<string, T>) => [...m.entries()].map(([key, v]) => ({ key, ...v }));
  return {
    total,
    byRun: rows(runs).sort((a, b) => b.costUsd - a.costUsd),
    byRole: rows(roles).sort((a, b) => b.costUsd - a.costUsd),
    byDay: rows(days).sort((a, b) => (a.key < b.key ? 1 : -1)),
  };
}
