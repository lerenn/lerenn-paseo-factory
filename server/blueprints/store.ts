import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Blueprint } from "../../shared/blueprints/blueprint";
import type { RunStatus } from "../../shared/blueprints/run";

/** One step a stage worker finished, saved with blueprint_progress. */
export interface StageProgress {
  /** The step, unique within the entry (for a QA, the criterion number). A new record with the same key replaces the old one. */
  key: string;
  /** Its outcome in the worker's words: pass, fail, skipped... */
  status: string;
  /** Evidence and what it was checked against (a head sha, a command, a path). */
  note: string;
  at: number;
}

export interface StageState {
  status: "pending" | "entering" | "running" | "waiting" | "done" | "exhausted" | "skipped" | "failed";
  /** Entries into the stage over the run. */
  runs: number;
  /** Tries within the current entry. */
  attempts: number;
  /** The next "wake" prompt says why the run was held (a provider usage limit), then it is cleared. */
  wakeReason?: "usage_limit" | null;
  /** A start refused for cluster quota, retried by the tick at `at` (1, 2, 4, 8 min back-off), replaying the same dispatch; no attempt is used. */
  /** Pod starts of this stage that failed in a row (reset by a start that works). */
  podStartFailures?: number;
  /** The worker said it waits on a person or an outside system (blueprint_waiting): since when; no nudges until the ceiling. */
  workerWaitSince?: number | null;
  /** No extension provided the stage's kind yet: since when the stage waits for one to register. */
  kindWaitSince?: number | null;
  quotaRetry?: { n: number; at: number; why: "start" | "nudge" | "retry" | "wake"; opts: { free?: boolean; fresh?: boolean; archiveOld?: boolean; attach?: string } } | null;
  /** Extra attempts and runs granted by the PM. */
  extra: number;
  flakes: number;
  /** Reasons of every infrastructure failure of the current entry (retried or not). Absent in older saved runs. */
  flakeReasons?: string[];
  /**
   * Results the stage's workers saved step by step in the current entry (blueprint_progress), kept in the run store so a
   * replacement worker (pod evicted, OOMKilled, session gone) reads them instead of redoing the steps. Cleared on entry.
   * Absent in older saved runs.
   */
  progress?: StageProgress[];
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
    /** A "merged" answer found the PR in the merge queue: the gate waits for the merge (passive) instead of asking again. */
    queued?: boolean;
    /** Polls in a row that did not see the queued PR in the merge queue. */
    notQueuedPolls?: number;
    /** The "still in the merge queue" notice went out. */
    slowNoticed?: boolean;
    /** A merge wait re-armed at expiry because its PRs were still in the merge queue: the timeout counts from here (decision 9b98fade). */
    expiresFrom?: number;
    /** Times the merge wait was re-armed that way. */
    rearms?: number;
    /** A merge wait (not a "merged" answer): PRs seen in the merge queue, polls in a row each was then seen out of it, and the
     *  head each "left the merge queue" notice was sent for (one per PR head). */
    inQueue?: Record<string, true>;
    outPolls?: Record<string, number>;
    leftNoticed?: Record<string, string>;
  } | null;
  childRunId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  lastNudgeAt: number | null;
  /** A gate answered "hold" is asked again at this time. */
  reopenAt?: number | null;
  /** The worker of this attempt already got its one free "call your verdict" nudge (decision c8125131). */
  verdictNudged?: boolean;
  /** Worktree checks of a fresh worker that failed in this entry (`worktree_check`, decision 12885996). */
  worktreeFailures?: number;
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
  pm: {
    judged: Record<string, { at: number; decision: string }>;
    pending: { stage: string; reason: string } | null;
    /** The on-demand PMs of the run, by judgement key `<run>:<point>:<stage>:<entry>` (one per key). Absent in older saved runs. */
    calls?: Record<string, PmCall>;
  };
  history: HistoryEvent[];
  /** Inbox items asking a person about a stuck or paused run: item id -> the stage and what was asked. */
  escalations?: Record<string, { stage: string; kind: "stuck" | "setup" }>;
  /** Waiting for a slot under the blueprint's `max_active`: the stage it starts at once dequeued. */
  queued?: { first: string; at: number } | null;
  /** The stage whose edge led into the current one (`{{from.*}}` in templates). */
  prev?: string | null;
  /** The workspace (pod) the stages marked `workspace = "run"` share, once the first of them has created it. */
  sharedWorkspaceId?: string | null;
  /** Every agent the Factory spawned for this run, with the workspace (pod) it lives in; what the janitor cleans up. */
  agents?: Record<string, SpawnedAgent>;
  /** Workers replaced while mid-turn: archived when their turn ends. */
  retiring?: string[];
  /** Why and since when the run is suspended (status "suspended"), the status to go back to, and what happened to its worker's pod. */
  suspended?: { reason: string; at: number; by: string; prevStatus: RunStatus; pods: string[]; usageLimit?: UsageLimitHold | null } | null;
  /** What happened after the run ended: event mails already sent, the retro, the janitor. */
  post?: PostState;
}

/** A run held for a provider usage limit ("paused: quota"): only these are resumed by the usage-limit scheduler, never a person's suspension. */
export interface UsageLimitHold {
  /** "own" (this run's worker hit the limit) or "global" (held with the whole Factory). */
  source: "own" | "global";
  rule: string | null;
  evidence: string | null;
  provider: string | null;
  agentId: string | null;
  resetAt: number | null;
  /** When the scheduler resumes it (own holds only; a global hold resumes with the Factory). */
  resumeAt: number | null;
}

/** Where the engine asks for a judgement: an exhausted stage, a failed run, a `pm = true` gate, a resume decision. */
export type PmPoint = "exhausted" | "failed" | "gate" | "resume";

/** One on-demand PM: spawned for one judgement key, archived when its turn ends (or on its timeout). */
export interface PmCall {
  key: string;
  point: PmPoint;
  stage: string;
  entry: number;
  agentId: string | null;
  startedAt: number;
  endedAt: number | null;
  /** "active": deciding; "escalated": waiting for an answer to its escalation (kept alive); then how it ended. */
  state: "active" | "escalated" | "done" | "handover" | "timeout" | "gone" | "unavailable";
  /** The Inbox item of a `pm = true` gate: the only item this PM may answer. */
  gateItemId?: string | null;
  /** The PM's escalation: step 1 to the escalation target, step 2 to the human through the Inbox. */
  escalation?: { step: 1 | 2; target: string; at: number; question: string } | null;
  /** What the PM decided (blueprint_pm_done) or why the call ended. */
  outcome?: string | null;
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
  /** Every workspace (pod) the Factory created, from the moment it exists (before its agent): what the orphan sweep may take. */
  workspaces?: Record<string, CreatedWorkspace>;
}

export interface CreatedWorkspace {
  at: number;
  run: string | null;
  title: string;
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
        this.state = { runs: s.runs ?? [], approvals: s.approvals ?? {}, suspended: s.suspended ?? null, workspaces: s.workspaces ?? {} };
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

  /** The latest run started with this key. */
  byKey(key: string): Run | undefined {
    for (let i = this.state.runs.length - 1; i >= 0; i--) if (this.state.runs[i]!.idempotencyKey === key) return this.state.runs[i];
    return undefined;
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

  /** A workspace the Factory just created (its agent may not exist yet). */
  noteWorkspace(id: string, w: CreatedWorkspace): void {
    (this.state.workspaces ??= {})[id] = w;
    this.save();
  }

  createdWorkspaces(): Record<string, CreatedWorkspace> {
    return (this.state.workspaces ??= {});
  }

  forgetWorkspaces(ids: Iterable<string>): void {
    let changed = false;
    for (const id of ids) if (this.state.workspaces?.[id]) {
      delete this.state.workspaces[id];
      changed = true;
    }
    if (changed) this.save();
  }

  prune(now: number): void {
    this.state.runs = this.state.runs.filter((r) => r.endedAt === null || now - r.endedAt < FINISHED_KEEP_MS);
  }
}
