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
  /** A start refused for cluster quota, retried by the tick at `at` (1, 2, 4, 8 min back-off), replaying the same dispatch; no attempt is used. */
  quotaRetry?: { n: number; at: number; why: "start" | "nudge" | "retry" | "wake"; opts: { free?: boolean; fresh?: boolean; archiveOld?: boolean; attach?: string } } | null;
  /** Extra attempts and runs granted by the PM. */
  extra: number;
  flakes: number;
  /** Reasons of every infrastructure failure of the current entry (retried or not). Absent in older saved runs. */
  flakeReasons?: string[];
  agentId: string | null;
  wardenTask: string | null;
  verdict: string | null;
  summary: string | null;
  data: Record<string, unknown>;
  notes: string[];
  gate: {
    itemId: string;
    heads: Record<string, string>;
    criteriaSha: string | null;
    reused: boolean;
    /** Absent in older saved runs. */
    openedAt?: number;
    /** Reminders sent for an approval gate that nobody answered, and when the last one went. */
    reminders?: number;
    remindedAt?: number;
    /** A wait for a merge (`wait = "merge"`): no Inbox item, `itemId` is empty. */
    passive?: boolean;
  } | null;
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
  /** The stage whose edge led into the current one (`{{from.*}}` in templates). */
  prev?: string | null;
  /** The workspace (pod) the stages marked `workspace = "run"` share, once the first of them has created it. */
  sharedWorkspaceId?: string | null;
  /** Every agent the Factory spawned for this run, with the workspace (pod) it lives in; what the janitor cleans up. */
  agents?: Record<string, SpawnedAgent>;
  /** Workers replaced while mid-turn: archived when their turn ends. */
  retiring?: string[];
  /** Why and since when the run is suspended (status "suspended"), the status to go back to, and what happened to its worker's pod. */
  suspended?: { reason: string; at: number; by: string; prevStatus: RunStatus; pods: string[] } | null;
  /** What happened after the run ended: event mails already sent, the retro, the janitor. */
  post?: PostState;
}

export interface SpawnedAgent {
  role: string;
  stage: string;
  workspaceId: string | null;
  /** The Factory archived the workspace when the worker was retired. */
  workspaceArchived?: boolean;
}

export interface PostState {
  /** Dedupe keys of the event mails sent. */
  mailed: string[];
  phase: "new" | "retro" | "archive" | "done";
  retro?: { agentId: string | null; startedAt: number } | null;
  /** The janitor's plan, made before the retro so the retro can report it. */
  plan?: JanitorPlan | null;
  archived?: string[];
}

export interface JanitorTarget {
  workspaceId: string | null;
  agentIds: string[];
}

export interface JanitorPlan {
  archive: JanitorTarget[];
  keep: (JanitorTarget & { why: string })[];
  dryRun: boolean;
}

interface State {
  runs: Run[];
  /** Approvals reusable by wording: key (ticket, stage, criteria sha) -> the option chosen. */
  approvals: Record<string, { optionId: string; by: string; at: number }>;
  /** The whole Factory is suspended: no run starts and nothing is respawned, across plugin reloads. */
  suspended: { reason: string; at: number; by: string } | null;
}

const MAX_HISTORY = 400;
const FINISHED_KEEP_MS = 30 * 24 * 3600 * 1000;

/** Runs as JSON, written before every transition so a daemon restart loses nothing. */
export class RunStore {
  private state: State = { runs: [], approvals: {}, suspended: null };

  constructor(private readonly file: string | null) {
    if (file) {
      try {
        const s = JSON.parse(readFileSync(file, "utf8"));
        this.state = { runs: s.runs ?? [], approvals: s.approvals ?? {}, suspended: s.suspended ?? null };
      } catch {
        this.state = { runs: [], approvals: {}, suspended: null };
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

  /** Set while the whole Factory is suspended. */
  suspended(): State["suspended"] {
    return this.state.suspended;
  }

  setSuspended(value: State["suspended"]): void {
    this.state.suspended = value;
    this.save();
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
