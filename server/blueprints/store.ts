import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Blueprint } from "../../shared/blueprints/blueprint";
import type { RunStatus } from "../../shared/blueprints/run";

export interface StageState {
  status: "pending" | "entering" | "running" | "waiting" | "done" | "exhausted" | "skipped" | "failed";
  /** Entries into the stage over the run. */
  runs: number;
  /** Tries within the current entry. */
  attempts: number;
  /** Extra attempts and runs granted by the PM. */
  extra: number;
  flakes: number;
  agentId: string | null;
  wardenTask: string | null;
  verdict: string | null;
  summary: string | null;
  data: Record<string, unknown>;
  notes: string[];
  gate: { itemId: string; heads: Record<string, string>; criteriaSha: string | null; reused: boolean } | null;
  childRunId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  lastNudgeAt: number | null;
  /** A gate answered "hold" is asked again at this time. */
  reopenAt?: number | null;
}

export interface HistoryEvent {
  at: number;
  stage: string | null;
  event: string;
  detail: string | null;
}

export interface Run {
  id: string;
  blueprint: string;
  sha: string;
  /** The definition as it was when the run started: later edits of the file do not change a run. */
  def: Blueprint;
  vars: Record<string, string>;
  status: RunStatus;
  stage: string | null;
  stages: Record<string, StageState>;
  requestedBy: string;
  ownerAgentId: string | null;
  pmAgentId: string | null;
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  error: string | null;
  waitingFor: string | null;
  parent: { runId: string; stageId: string } | null;
  pm: { judged: Record<string, { at: number; decision: string }>; pending: { stage: string; reason: string } | null };
  history: HistoryEvent[];
  /** Inbox items asking a person about a stuck or paused run: item id -> the stage and what was asked. */
  escalations?: Record<string, { stage: string; kind: "stuck" | "setup" }>;
}

interface State {
  runs: Run[];
  /** Approvals reusable by wording: key (ticket, stage, criteria sha) -> the option chosen. */
  approvals: Record<string, { optionId: string; by: string; at: number }>;
}

const MAX_HISTORY = 400;
const FINISHED_KEEP_MS = 30 * 24 * 3600 * 1000;

/** Runs as JSON, written before every transition so a daemon restart loses nothing. */
export class RunStore {
  private state: State = { runs: [], approvals: {} };

  constructor(private readonly file: string | null) {
    if (file) {
      try {
        const s = JSON.parse(readFileSync(file, "utf8"));
        this.state = { runs: s.runs ?? [], approvals: s.approvals ?? {} };
      } catch {
        this.state = { runs: [], approvals: {} };
      }
    }
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  newId(): string {
    return `bp-${randomBytes(4).toString("hex")}`;
  }

  add(run: Run): void {
    this.state.runs.push(run);
    this.save();
  }

  get(id: string): Run | undefined {
    return this.state.runs.find((r) => r.id === id);
  }

  all(): Run[] {
    return this.state.runs;
  }

  active(): Run[] {
    return this.state.runs.filter((r) => r.status === "running" || r.status === "waiting" || r.status === "paused");
  }

  byKey(key: string): Run | undefined {
    return this.state.runs.find((r) => r.idempotencyKey === key);
  }

  approval(key: string) {
    return this.state.approvals[key];
  }

  approve(key: string, optionId: string, by: string, at: number): void {
    this.state.approvals[key] = { optionId, by, at };
    this.save();
  }

  log(run: Run, event: string, stage: string | null, detail: string | null, now: number): void {
    run.history.push({ at: now, stage, event, detail });
    if (run.history.length > MAX_HISTORY) run.history.splice(0, run.history.length - MAX_HISTORY);
    run.updatedAt = now;
  }

  prune(now: number): void {
    this.state.runs = this.state.runs.filter((r) => r.endedAt === null || now - r.endedAt < FINISHED_KEEP_MS);
  }
}
