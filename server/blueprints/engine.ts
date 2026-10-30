import { approvalKey, customLabel, runLabel } from "../../shared/blueprints/label";
import { flakeReason, flakeSummary, isStartFailure, isBusyError, isGitTimeout, isQuotaError, MAX_BUSY_RETRIES, MAX_GIT_TIMEOUTS, quotaBackoffMs, SESSION_GONE } from "./flake";
import { createHash } from "node:crypto";
import type { StageKindContext, StageOutcome } from "../extensions";
import { TERMINALS, stageVerdicts, type AgentStage, type Blueprint, type CallStage, type GateStage, type BlueprintStage, type Stage } from "../../shared/blueprints/blueprint";
import type { RunView, StageView } from "../../shared/blueprints/run";
import type { Run, RunStore, StageProgress, StageState, UsageLimitHold } from "./store";
import type { Classification, ProviderFailure } from "../../shared/blueprints/usage-limit";
import { condition, render } from "./template";
import { workspaceTitle } from "../workspace-title";
import { PostRun } from "./post";
import { buildDigest } from "./digest";
import { escalationHow, PM_DEFAULTS, pmCalls, pmKey, pmLive, pmPrompt, pmTitle, type PmSettings } from "./pm";
import type { PmCall, PmPoint } from "./store";
import { GitHubUnavailableError, isTransientError, TRANSIENT_NOTICE_MS, transientBackoffMs, withQuickRetry } from "./transient";

export class UsageError extends Error {}
export class NotFoundError extends UsageError {}
/** GitHub did not answer a read the action needs (after quick retries): nothing was changed, try again. */
export class RetryLaterError extends UsageError {}

/** How long a worker may say it waits on a person or an outside system (no nudges meanwhile) before the run pauses for a person. */
const WORKER_WAIT_CEILING_MS = 120 * 60_000;

/** How long a stage waits for the extension that provides its kind to register (after a restart) before the run fails. */
const KIND_WAIT_MS = 15 * 60_000;

/** Polls in a row that must not see a queued PR in the queue before the merge gate asks again. */
const LEFT_QUEUE_POLLS = 2;

export interface PrFacts {
  url: string;
  exists: boolean;
  state: "open" | "closed" | "merged";
  head: string;
  ci: "green" | "red" | "pending" | "none";
  mergeable: boolean | null;
  draft: boolean;
  review: string;
  /** Auto-merge is on or the PR is in a merge queue: it merges by itself (absent: unknown). */
  queued?: boolean;
  /** Place in the merge queue (1 = next) and GitHub's estimate of the time left, in seconds (absent: not in a queue or unknown). */
  queuePosition?: number;
  queueEtaSeconds?: number;
}

export type GateState = {
  status: "pending" | "answered" | "expired" | "withdrawn" | "archived";
  optionId: string | null;
  text: string | null;
  by: string | null;
} | null;

export interface Ports {
  now(): number;
  spawn(o: { idempotencyKey: string; role: string; prompt: string; title: string; workspaceTitle?: string; cwd?: string; labels: Record<string, string>; env: Record<string, string>; /** Overrides the Factory runtime setting for this agent. */ runtime?: string; joinWorkspaceId?: string }): Promise<{ agentId: string; workspaceId?: string | null }>;
  send(agentId: string, text: string): Promise<void>;
  /** A new run exists (the Supervisor wakes on it). */
  runStarted?(run: Run): void;
  /** Information for an agent (not a task): Agents Mail when installed, else `send`. */
  report?(agentId: string, report: { subject: string; body: string; kind: string }): Promise<void>;
  /** Settings of the event mails, the retro and the janitor. */
  post?(): PostSettings;
  /** No model call should start now (the Factory is paused for a usage limit): the retro waits. */
  quiet?(): boolean;
  /** Archive a workspace (the pod of an agent on a runtime plugin). */
  archiveWorkspace?(workspaceId: string): Promise<void>;
  /** Suspend a workspace through its runtime (volume kept). `busy` says why it was refused (an agent is running in it). Absent: nothing to suspend. */
  suspendWorkspace?(workspaceId: string, force: boolean): Promise<{ ok: boolean; message?: string }>;
  /** Wake a suspended workspace ahead of the prompt that would wake it anyway. */
  wakeWorkspace?(workspaceId: string): Promise<void>;
  /** `git status --short` of the workspace, for the history only (5 s at most, never throws): it never keeps a workspace. */
  trace?(workspaceId: string): Promise<string>;
  /**
   * The fresh worker's checkout answers git within `timeoutMs` (`worktree_check`), counted from when its workspace is up, which
   * may take `bootMs` (`worktree_boot_grace`); never throws. `unchecked`: the workspace never came up, nothing was probed. Absent: no check.
   */
  worktreeCheck?(workspaceId: string, timeoutMs: number, bootMs?: number): Promise<{ ok: boolean; detail: string; unchecked?: boolean }>;
  /** Ids of the agents still alive in a workspace, or null when they could not be listed. Absent: only the run's own agents are known. */
  liveAgentsIn?(workspaceId: string): Promise<string[] | null>;
  /** Usage recorded for a run / an agent. */
  spend?(runId: string): { costUsd: number; turns: number } | null;
  spendOfAgent?(agentId: string): number;
  agentState(agentId: string): Promise<"running" | "idle" | "gone">;
  archive(agentId: string): Promise<void>;
  ask(o: {
    runId: string;
    /** Shown as the asker in the Inbox. */
    title: string;
    question: string;
    context: string;
    options: { id: string; label: string; description?: string; recommended?: boolean }[];
    freeText: boolean;
    dedupeKey: string;
    expiresInMinutes?: number;
    kind?: "question" | "approval";
  }): { itemId: string };
  gate(itemId: string): GateState;
  withdraw(itemId: string, reason: string): void;
  wardenRegister(o: { agentId: string; task: string }): string | null;
  wardenDone(taskId: string, result: string): void;
  /**
   * Facts of a PR, through the Factory's per-URL cache: served from memory when younger than `maxAgeMs` (default 2 min, merged
   * and closed PRs for the life of the run); `maxAgeMs: 0` reads the PR now (a gate that needs the current head). The read goes to
   * the registered facts provider, else the Factory's own `gh` reads (`facts-provider.ts`).
   */
  prFacts(url: string, opts?: { maxAgeMs?: number }): Promise<PrFacts>;
  /** A pull request URL the Factory can read facts of (default: a GitHub PR URL, the fallback's). */
  isPrUrl?(url: string): boolean;
  /** A Factory or extension tool by name, else null. */
  tool(name: string): ((args: Record<string, unknown>) => Promise<unknown> | unknown) | null;
  stageKind(kind: string): ((ctx: Omit<StageKindContext, "paseo" | "services" | "signal">) => Promise<StageOutcome>) | null;
  blueprint(name: string): { blueprint: Blueprint; sha: string } | undefined;
  /** Static checks at start: a message when the run could not possibly start its workers (no working directory...). */
  preflight?(def: Blueprint, at: string): string | null;
  settings(): { defaultCwd: string | undefined; pmRole: string; idleGraceSeconds: number; archiveOnFinish: boolean; shareWorkspace?: boolean; flakeRetries?: number; runsMailTo?: string; criteriaReminderMinutes?: number; pm?: Partial<PmSettings>; /** One free "call your verdict" nudge per attempt (decision c8125131). */ verdictNudge?: boolean };
  /** Where an on-demand PM escalates first: "supervisor", an agent address or alias, or "" (straight to the human). */
  escalationTarget?(): string;
  /** Pause between the quick retries of a transient PR-facts read (default a real timer; tests pass a no-op). */
  sleep?(ms: number): Promise<void>;
}

/** The usage-limit controller as the engine sees it (server/blueprints/usage-limit). Absent or disabled: nothing changes. */
export interface UsageLimitHook {
  enabled(): boolean;
  classify(f: ProviderFailure): Classification;
  /** When a run held on its own match resumes. */
  resumeAtFor(resetAt: number | null): number;
  /** A worker hit the limit; its run is already held. Called outside the run's chain. */
  matched(e: { runId: string; agentId: string | null; provider: string | null; rule: string; evidence: string; resetAt: number | null }): void;
  /** A failed turn nobody classified (not a usage limit, a flake or a known class): one alert per signature. */
  unknown(e: { runId: string; agentId: string | null; failure: ProviderFailure }): void;
  /** The whole Factory is held for a usage limit. */
  globalHold(): { reason: string; resumeAt: number | null } | null;
}

export interface PostSettings {
  /** Who gets the event mails ("" = nobody). */
  eventsMailTo: string;
  retro: { enabled: boolean; mailTo: string; role: string; maxUsd: number; timeoutMinutes: number; skipTrivial: boolean; prompt?: string; /** Empty or absent: the Factory's runtime. */ runtime?: string };
  janitor: { enabled: boolean; dryRun: boolean };
}

/** Something a person or the PM should hear about while a run goes on. */
export interface RunEvent {
  kind: "waiting" | "exhausted" | "failed" | "aborted";
  stage: string | null;
  reason: string;
  /** Same key, same event: sent once. */
  key: string;
}

/** What watches runs from outside: event mails, the retro and the janitor (see post.ts). */
export interface Observer {
  event(run: Run, e: RunEvent): void;
  finished(run: Run): void;
  retroEnded?(agentId: string): void;
  tick?(): void;
  /** A Factory-level notice (not tied to a run) mailed to events.mailTo; the caller dedupes. */
  notice?(subject: string, body: string): void;
}

const APPROVAL = [
  { id: "approve", label: "Approve" },
  { id: "deny", label: "Deny" },
];

/** An approval gate nobody answers is reminded this many times at most. */
const MAX_REMINDERS = 3;

/** Progress records one stage entry keeps (blueprint_progress). */
export const MAX_PROGRESS = 50;

/** The saved results a replacement or woken worker reads first. */
export function progressBlock(progress: StageProgress[]): string {
  const lines = progress.map((p) => `- ${p.key}: ${p.status} (${new Date(p.at).toISOString()})${p.note ? ` — ${p.note}` : ""}`);
  return (
    `## Progress saved in this stage entry (Factory run store; it survives the pod)\n${lines.join("\n")}\n` +
    "Keep these results: do not redo a step listed here unless it no longer holds (for example the PR head or environment it names " +
    "changed). Do only the missing steps, save each with blueprint_progress, and give the verdict over all of them."
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const freshStage = (): StageState => ({
  status: "pending",
  runs: 0,
  attempts: 0,
  extra: 0,
  flakes: 0,
  flakeReasons: [],
  progress: [],
  agentId: null,
  wardenTask: null,
  verdict: null,
  summary: null,
  data: {},
  notes: [],
  gate: null,
  childRunId: null,
  startedAt: null,
  endedAt: null,
  lastNudgeAt: null,
});

export interface StartInput {
  blueprint: string;
  vars: Record<string, string>;
  at?: string;
  requestedBy: string;
  ownerAgentId?: string | null;
  idempotencyKey?: string;
  parent?: { runId: string; stageId: string };
}

/**
 * The flow engine. A run is a state machine over the stages of its blueprint: every transition is
 * recorded in the store before its effect (spawn, message, gate) happens, and `resumeAll` replays the
 * effect of anything caught half way after a restart.
 */
export class Engine {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly aborts = new Map<string, AbortController>();

  readonly observer: Observer;
  /** Set by the Blueprints module when the usage-limit feature is wired. */
  usageLimits: UsageLimitHook | null = null;

  constructor(
    readonly store: RunStore,
    private readonly ports: Ports,
  ) {
    this.observer = new PostRun(store, ports);
  }

  private sleep = (ms: number): Promise<void> => (this.ports.sleep ? this.ports.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)));

  /** Facts of `url` read now, retried quickly on a transient error (then a `GitHubUnavailableError`). */
  private freshFacts(url: string): Promise<PrFacts> {
    return withQuickRetry(() => this.ports.prFacts(url, { maxAgeMs: 0 }), this.sleep);
  }

  /**
   * A PR-facts read of stage `id` failed for a transient reason (GitHub 5xx, rate limit, network, timeout): the stage keeps waiting
   * and reads again after a back-off (30 s doubling to 10 min). `facts_transient` is logged once per streak, a person is told once
   * when the streak reaches 30 min, and the run never fails for it. `reopen`: the gate could not even open, the tick opens it at
   * the retry time.
   */
  private factsUnavailable(run: Run, id: string, error: unknown, how: "poll" | "reopen" | "answer"): void {
    const st = run.stages[id];
    const now = this.ports.now();
    const cause = error instanceof GitHubUnavailableError ? error.cause : error;
    const message = clip(cause instanceof Error ? cause.message : String(cause), 200);
    const r = (st.factsRetry ??= { since: now, n: 0, at: now, last: "" });
    r.n += 1;
    r.at = now + transientBackoffMs(r.n);
    r.last = message;
    r.answer = how === "answer" || r.answer;
    const retryIn = `${Math.round((r.at - now) / 1000)} s`;
    if (r.n === 1) this.log(run, "facts_transient", id, `GitHub unavailable (${message}): ${how === "answer" ? "the answer is applied" : "reading again"} in ${retryIn}, the stage keeps waiting`);
    if (how === "reopen") {
      st.gate = null;
      st.reopenAt = r.at;
    }
    st.status = "waiting";
    run.status = "waiting";
    run.waitingFor = `GitHub unavailable since ${Math.max(1, Math.round((now - r.since) / 60_000))} min (${message}); reading again in ${retryIn}`;
    if (!r.noticed && now - r.since >= TRANSIENT_NOTICE_MS) {
      r.noticed = true;
      const mins = Math.round((now - r.since) / 60_000);
      this.log(run, "facts_transient_long", id, `GitHub unavailable for ${mins} min (${r.n} reads): ${message}`);
      this.notify(run, { kind: "waiting", stage: id, reason: `GitHub has not answered the PR reads of stage ${id} for ${mins} min (${message}). The run keeps waiting and reads again every few minutes; nothing to do unless GitHub stays down.`, key: `${run.id}:facts-transient:${id}:${r.since}` });
    }
    this.store.save();
  }

  /** A PR-facts read of stage `id` worked again after a transient streak. */
  private factsRecovered(run: Run, id: string): void {
    const st = run.stages[id];
    if (!st?.factsRetry) return;
    this.log(run, "facts_recovered", id, `GitHub answers again after ${Math.max(1, Math.round((this.ports.now() - st.factsRetry.since) / 60_000))} min (${st.factsRetry.n} failed reads)`);
    st.factsRetry = null;
    this.store.save();
  }

  private notify(run: Run, e: RunEvent): void {
    try {
      this.observer.event(run, e);
    } catch (error) {
      console.error("blueprints: event failed", error);
    }
  }

  private registerAgent(run: Run, agentId: string, role: string, stage: string, workspaceId: string | null | undefined): void {
    (run.agents ??= {})[agentId] = { role, stage, workspaceId: workspaceId ?? null };
  }

  // ---- serialisation: one operation at a time per run ----

  private exclusive<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }

  // ---- starting ----

  /** Validate the variables and create the run; the first stage is entered in the background. */
  start(input: StartInput): Run {
    if (input.idempotencyKey) {
      // The same key joins the run it started; only a run that failed or was aborted lets the key start a new one.
      const existing = this.store.byKey(input.idempotencyKey);
      if (existing && existing.status !== "failed" && existing.status !== "aborted") return existing;
    }
    const held = this.store.suspended();
    if (held) throw new UsageError(`The Factory is suspended (${held.reason}); resume it with blueprint_resume(all=true) before starting runs.`);
    const limited = this.usageHold();
    if (limited) throw new UsageError(`The Factory is paused for a provider usage limit (${limited.reason})${limited.resumeAt ? ` until about ${new Date(limited.resumeAt).toISOString()}` : ""}; no run starts until it resumes or a person lifts it (Blueprints > Quota).`);
    const loaded = this.ports.blueprint(input.blueprint);
    if (!loaded) throw new NotFoundError(`No blueprint "${input.blueprint}".`);
    const { blueprint: def, sha } = loaded;
    const vars = this.checkVars(def, input.vars);
    const first = input.at ?? def.start ?? def.stage[0].id;
    if (!def.stage.some((s) => s.id === first)) throw new UsageError(`Blueprint ${def.name} has no stage "${first}".`);
    const problem = this.ports.preflight?.(def, first);
    if (problem) throw new UsageError(problem);
    const now = this.ports.now();
    const run: Run = {
      id: this.store.newId(),
      blueprint: def.name,
      sha,
      def,
      vars,
      status: "running",
      stage: null,
      stages: {},
      requestedBy: input.requestedBy,
      ownerAgentId: input.ownerAgentId ?? null,
      pmAgentId: input.ownerAgentId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      error: null,
      waitingFor: null,
      parent: input.parent ?? null,
      pm: { judged: {}, pending: null },
      history: [],
    };
    this.store.log(run, "started", first, `by ${input.requestedBy}${input.at ? ` at ${input.at}` : ""}`, now);
    const active = def.max_active ? this.activeOf(def.name) : 0;
    if (def.max_active && active >= def.max_active) {
      run.queued = { first, at: now };
      run.status = "waiting";
      run.waitingFor = `queued: ${active} ${def.name} runs active (max_active ${def.max_active})`;
      this.store.log(run, "queued", null, run.waitingFor, now);
      this.store.add(run);
      return run;
    }
    run.stage = first;
    run.stages[first] = { ...freshStage(), status: "entering" };
    this.store.add(run);
    void this.exclusive(run.id, () => this.enter(run, first)).catch((e) => this.crash(run, e));
    try {
      this.ports.runStarted?.(run);
    } catch (error) {
      console.error("blueprints: runStarted failed", error);
    }
    return run;
  }

  /** Runs of a blueprint that hold a slot under `max_active`: not ended, not queued. */
  private activeOf(blueprint: string): number {
    return this.store.active().filter((r) => r.blueprint === blueprint && !r.queued).length;
  }

  /** Starts queued runs, oldest first, while their blueprint has a free slot under `max_active`. */
  private async dequeue(): Promise<void> {
    if (this.store.suspended() || this.usageHold()) return;
    const queued = this.store.active().filter((r) => r.queued).sort((a, b) => a.queued!.at - b.queued!.at);
    for (const run of queued) {
      const max = run.def.max_active ?? Infinity;
      if (this.activeOf(run.blueprint) >= max) continue;
      const first = run.queued!.first;
      run.queued = null;
      run.status = "running";
      run.waitingFor = null;
      run.stage = first;
      run.stages[first] = { ...freshStage(), status: "entering" };
      this.log(run, "dequeued", first, `a ${run.blueprint} slot is free`);
      this.store.save();
      await this.exclusive(run.id, () => this.enter(run, first)).catch((e) => this.crash(run, e));
    }
  }

  private checkVars(def: Blueprint, given: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, spec] of Object.entries(def.vars)) {
      const value = given[name] ?? spec.default;
      if (value === undefined || value === "") {
        if (spec.required) throw new UsageError(`Variable ${name} is required${spec.description ? `: ${spec.description}` : ""}.`);
        out[name] = "";
        continue;
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) throw new UsageError(`Variable ${name} must match ${spec.pattern}, got "${clip(value, 60)}".`);
      out[name] = value;
    }
    for (const name of Object.keys(given)) if (!(name in def.vars) && !name.endsWith("_confirmed")) throw new UsageError(`Unknown variable ${name}.`);
    for (const name of def.confirm) {
      if (out[name] && given[`${name}_confirmed`] !== "true") {
        throw new UsageError(`${name} must be confirmed before this blueprint changes code: check it exists for real and pass ${name}_confirmed=true.`);
      }
      if (!out[name]) throw new UsageError(`${name} is required and must be confirmed.`);
    }
    return out;
  }

  // ---- templates ----

  private lookup(run: Run) {
    return (name: string): string | undefined => {
      if (name === "run.id") return run.id;
      if (name === "blueprint") return run.blueprint;
      const from = /^from\.(stage|verdict|summary)$/.exec(name);
      if (from) {
        const st = run.prev ? run.stages[run.prev] : undefined;
        return from[1] === "stage" ? (run.prev ?? "") : from[1] === "verdict" ? (st?.verdict ?? "") : (st?.summary ?? "");
      }
      const stage = /^stage\.([a-z][a-z0-9_-]*)\.(verdict|summary|data\.(.+))$/.exec(name);
      if (stage) {
        const st = run.stages[stage[1]];
        if (!st) return "";
        if (stage[2] === "verdict") return st.verdict ?? "";
        if (stage[2] === "summary") return st.summary ?? "";
        const value = st.data[stage[3]];
        if (value === undefined) return "";
        return typeof value === "string" ? value : Array.isArray(value) ? value.join(",") : JSON.stringify(value);
      }
      const key = name.startsWith("vars.") ? name.slice(5) : name;
      return run.vars[key];
    };
  }

  private r(run: Run, template: string): string {
    return render(template, this.lookup(run));
  }

  // ---- movement ----

  private stageDef(run: Run, id: string): Stage {
    const s = run.def.stage.find((x) => x.id === id);
    if (!s) throw new Error(`stage ${id} is not in blueprint ${run.blueprint}`);
    return s;
  }

  private log(run: Run, event: string, stage: string | null, detail: string | null = null): void {
    this.store.log(run, event, stage, detail, this.ports.now());
  }

  private crash(run: Run, error: unknown): void {
    const message = (error as Error)?.message ?? String(error);
    console.error(`blueprints: run ${run.id} failed`, error);
    if (run.status === "done" || run.status === "failed" || run.status === "aborted") return;
    this.finish(run, "failed", `engine error: ${message}`);
  }

  /** Follow an edge: a stage id, "done", "failed" or "pm". */
  private async go(run: Run, from: string, target: string, why: string): Promise<void> {
    this.log(run, "transition", from, `${why} -> ${target}`);
    if (target === "done") return this.finish(run, "done", null);
    if (target === "failed") return this.finish(run, "failed", `stage ${from}: ${why}`);
    run.prev = from;
    const left = run.stages[from]?.agentId;
    run.stage = target;
    run.stages[target] ??= freshStage();
    run.stages[target].status = "entering";
    run.status = "running";
    run.waitingFor = null;
    this.store.save();
    // The stage is done and the run moved on: its worker (and workspace) go, unless a stage that may still run reuses it.
    if (left && from !== target && (this.stageDef(run, from).kind ?? "agent") === "agent" && !run.def.stage.some((s) => "agent" in s && s.agent === `reuse:${from}`)) await this.retire(run, from, left);
    await this.enter(run, target);
  }

  private finish(run: Run, status: "done" | "failed" | "aborted", error: string | null, opts: { quiet?: boolean } = {}): void {
    const now = this.ports.now();
    run.status = status;
    run.error = error;
    run.endedAt = now;
    run.waitingFor = null;
    run.suspended = null;
    run.pm.pending = null;
    this.log(run, status, run.stage, error);
    this.store.save();
    this.aborts.get(run.id)?.abort();
    for (const itemId of Object.keys(run.escalations ?? {})) this.ports.withdraw(itemId, `run ${status}`);
    for (const st of Object.values(run.stages)) {
      if (st.wardenTask) {
        this.ports.wardenDone(st.wardenTask, `run ${status}`);
        st.wardenTask = null;
      }
      if (st.gate && st.status === "waiting") {
        if (st.gate.itemId) this.ports.withdraw(st.gate.itemId, `run ${status}`);
        st.status = "failed";
      }
    }
    this.store.save();
    if (run.parent) {
      const parent = this.store.get(run.parent.runId);
      if (parent) void this.exclusive(parent.id, () => this.childFinished(parent, run)).catch((e) => this.crash(parent, e));
    }
    const text = `Factory: run ${run.id} of blueprint ${run.blueprint} ${status}${error ? `: ${clip(error, 300)}` : ""}.`;
    const mailTo = this.ports.settings().runsMailTo?.trim();
    if (mailTo && this.ports.report) void this.ports.report(mailTo, { subject: `Run ${run.id} ${this.runLabel(run)} ${status}`, body: `${text}\n${this.runFacts(run)}`, kind: "run" }).catch(() => undefined);
    else for (const id of new Set([run.ownerAgentId, run.pmAgentId].filter((x): x is string => !!x && !this.isPmAgent(run, x)))) void (this.ports.report ? this.ports.report(id, { subject: `Run ${run.id} ${status}`, body: text, kind: "run" }) : this.ports.send(id, text)).catch(() => undefined);
    if (status !== "done" && !opts.quiet) this.notify(run, { kind: status, stage: run.stage, reason: error ?? status, key: `${run.id}:${status}` });
    // A failed run gets a PM (a child's failure is judged by its parent's PM, at the parent's stage).
    if (status === "failed" && !opts.quiet && !run.parent && this.pmMode()) {
      const stage = run.stage ?? run.def.stage[0].id;
      void this.exclusive(run.id, () => this.judge(run, "failed", stage, `The run failed at stage "${stage}": ${error ?? "no detail"}.`)).catch((e) => console.error(`blueprints: PM of failed run ${run.id}`, e));
    }
    // The janitor (after the retro) replaces the blunt archive-everything switch.
    if (!this.ports.post?.().janitor.enabled && this.ports.settings().archiveOnFinish) for (const st of Object.values(run.stages)) if (st.agentId) void this.ports.archive(st.agentId).catch(() => undefined);
    if (!this.ports.post?.().janitor.enabled) void this.retireWorkers(run).catch((e) => console.error(`blueprints: retiring workers of ${run.id} failed`, e));
    try {
      this.observer.finished(run);
    } catch (error) {
      console.error("blueprints: post-run failed", error);
    }
  }

  private async childFinished(parent: Run, child: Run): Promise<void> {
    if (parent.status === "suspended") return; // replayed when the parent is resumed
    const id = Object.entries(parent.stages).find(([, st]) => st.childRunId === child.id)?.[0];
    if (!id || parent.stage !== id) return;
    const st = parent.stages[id];
    st.verdict = child.status;
    st.summary = child.error ?? `child run ${child.id} ${child.status}`;
    st.status = "done";
    st.endedAt = this.ports.now();
    const def = this.stageDef(parent, id);
    await this.go(parent, id, def.on[child.status] ?? (child.status === "done" ? "done" : "failed"), `child ${child.id} ${child.status}`);
  }

  // ---- entering a stage ----

  private async enter(run: Run, id: string, opts: { attach?: string } = {}): Promise<void> {
    if (run.status === "done" || run.status === "failed" || run.status === "aborted" || run.status === "suspended") return;
    const def = this.stageDef(run, id);
    const st = (run.stages[id] ??= freshStage());
    run.stage = id;
    if (def.skip_if && condition(this.r(run, def.skip_if))) {
      st.status = "skipped";
      st.verdict = "skipped";
      this.log(run, "skipped", id, def.skip_if);
      return this.go(run, id, def.on.skipped ?? "done", "skipped");
    }
    // Decision 12885996: a run whose PRs were all merged meanwhile (by a person, the queue) goes straight on instead of babysitting,
    // implementing or QA-ing merged code, or asking a person about it.
    if (def.skip_if_merged && def.on.already_merged) {
      const urls = this.prUrls(run, def.skip_if_merged);
      if (await this.allMerged(urls)) {
        st.status = "skipped";
        st.verdict = "already_merged";
        st.summary = `every PR is already merged: ${urls.join(", ")}`;
        this.log(run, "already_merged", id, urls.join(", "));
        return this.go(run, id, def.on.already_merged, "every PR already merged");
      }
    }
    st.runs += 1;
    st.attempts = 0;
    st.flakes = 0;
    st.flakeReasons = [];
    st.progress = [];
    st.verdictNudged = false;
    st.worktreeFailures = 0;
    st.startedAt = this.ports.now();
    st.endedAt = null;
    st.verdict = null;
    const kind = def.kind ?? "agent";
    const maxRuns = kind === "agent" ? (def as AgentStage).max_runs : Infinity;
    if (st.runs > maxRuns + st.extra) return this.exhausted(run, id, `entered ${st.runs - 1} times (max_runs ${maxRuns})`);
    this.log(run, "enter", id, `${kind} run ${st.runs}`);
    this.store.save();
    switch (kind) {
      case "agent":
        return this.dispatch(run, id, "start", opts.attach ? { attach: opts.attach } : {});
      case "gate":
        return this.openGate(run, id, def as GateStage);
      case "call":
        return this.doCall(run, id, def as CallStage);
      case "blueprint":
        return this.startChild(run, id, def as BlueprintStage);
      default:
        return this.runExtension(run, id, def);
    }
  }

  // ---- exhaustion and the PM ----

  private async exhausted(run: Run, id: string, reason: string): Promise<void> {
    const st = run.stages[id];
    st.status = "exhausted";
    if (st.flakeReasons?.length) reason = `${reason}; ${flakeSummary(st.flakeReasons)}`;
    const def = this.stageDef(run, id);
    const target = def.on.exhausted ?? "failed";
    this.log(run, "exhausted", id, reason);
    const judged = !!run.pm.judged[id];
    this.notify(run, { kind: "exhausted", stage: id, reason: `${reason}${target === "pm" && !judged ? "; waiting for the PM's judgement" : ""}`, key: `${run.id}:exhausted:${id}:${run.history.length}` });
    if (target !== "pm") return this.go(run, id, target, `exhausted: ${reason}`);
    if (judged) {
      this.escalate(run, id, `${reason}; the PM already judged this stage once`);
      return this.finish(run, "failed", `stage ${id} exhausted after the PM's judgement: ${reason}`, { quiet: true });
    }
    run.status = "waiting";
    run.waitingFor = `PM judgement on stage ${id}`;
    run.pm.pending = { stage: id, reason };
    this.store.save();
    await this.notifyPm(run, this.pmText(run, id, reason));
  }

  private pmText(run: Run, id: string, reason: string): string {
    const max = run.def.pm_extra_max;
    return (
      `Factory: stage "${id}" of run ${run.id} (${run.blueprint}) is exhausted: ${reason}.\n` +
      `You get ONE judgement call on it. Call blueprint_retry(run="${run.id}", stage="${id}", ...) with extra_attempts (1-${max}, optional note for the worker) to grant bounded extra attempts, ` +
      `or with to="<stage>" and a note to re-scope; or escalate: ask the human with inbox_ask, then blueprint_abort(run="${run.id}") or blueprint_resume once decided.\n` +
      `Last summary: ${run.stages[id]?.summary ?? "none"}`
    );
  }

  /** True while the run's PM exists; a run without one is steered by anyone, and judged by the human. */
  async hasLivePm(run: Run): Promise<boolean> {
    return !!run.pmAgentId && (await this.ports.agentState(run.pmAgentId)) !== "gone";
  }

  private askerTitle(run: Run): string {
    return `Factory · ${run.blueprint} · ${runLabel(run)}`;
  }

  /** Stop the run where it is with a reason, ask the human through the Inbox, and wait for `blueprint_resume`. */
  private pause(run: Run, id: string, reason: string, opts: { human?: boolean } = {}): void {
    run.status = "paused";
    run.error = reason;
    run.waitingFor = `a person: ${reason}`;
    this.log(run, "paused", id, reason);
    this.store.save();
    this.notify(run, { kind: "waiting", stage: id, reason: `paused for a person: ${reason}`, key: `${run.id}:paused:${id}:${run.history.length}` });
    if (opts.human || !this.pmMode()) return this.escalate(run, id, reason, "setup");
    // A resume decision: the run's PM first, the human when no PM takes it.
    void this.exclusive(run.id, async () => {
      if (run.status !== "paused" || run.stage !== id) return;
      if (!(await this.judge(run, "resume", id, `The run is paused at stage "${id}": ${reason}.`))) this.escalate(run, id, reason, "setup");
    }).catch((e) => this.crash(run, e));
  }

  /** The run is moving again: the questions asked of a person while it was stuck or paused no longer matter. */
  private withdrawEscalations(run: Run, why: string): void {
    for (const itemId of Object.keys(run.escalations ?? {})) {
      try {
        this.ports.withdraw(itemId, why);
      } catch (error) {
        console.error(`blueprints: withdrawing ${itemId} failed`, error);
      }
    }
    run.escalations = {};
  }

  private escalate(run: Run, id: string, why: string, kind: "stuck" | "setup" = "stuck"): void {
    const options =
      kind === "setup"
        ? [
            { id: "resume", label: "Resume (after fixing)", description: "Continue the run at this stage once the cause is fixed.", recommended: true },
            { id: "abort", label: "Abort", description: "Stop the run for good." },
          ]
        : [
            { id: "resume1", label: "Resume with +1 attempt", description: "One more try at this stage.", recommended: true },
            { id: "resume3", label: "Resume with +3 attempts", description: "Three more tries at this stage." },
            { id: "abort", label: "Abort the run", description: "Stop the run for good." },
            { id: "leave", label: "Leave it failed", description: "Do nothing; resume it later from the Blueprints tab." },
          ];
    try {
      const { itemId } = this.ports.ask({
        runId: run.id,
        title: this.askerTitle(run),
        question: `Run ${run.id} (${run.blueprint}) is ${kind === "setup" ? "paused" : "stuck"} at stage ${id}: ${clip(why, 400)}`,
        context: `Blueprint ${run.blueprint} sha ${run.sha}, vars ${JSON.stringify(run.vars)}. "Other…": your text is passed to the worker as a note and the stage resumes with +1 attempt.`,
        options,
        freeText: true,
        dedupeKey: `${run.id}:escalation:${id}:${run.history.length}`,
        kind: "question",
      });
      (run.escalations ??= {})[itemId] = { stage: id, kind };
      this.store.save();
    } catch (error) {
      console.error("blueprints: escalation failed", error);
    }
  }

  private runLabel(run: Run): string {
    return runLabel(run, run.blueprint);
  }

  /** Run id, blueprint and a short summary of its vars (not the internal *_confirmed flags). */
  private runFacts(run: Run): string {
    const vars = Object.entries(run.vars).filter(([k]) => !k.endsWith("_confirmed")).map(([k, v]) => `${k}=${clip(String(v), 80)}`).join(", ");
    return `Run: ${run.id}\nBlueprint: ${run.blueprint}${vars ? `\nVars: ${clip(vars, 300)}` : ""}`;
  }

  private async notifyPm(run: Run, text: string): Promise<void> {
    // With runs.notifyMailTo set, a judgement request is mailed there (queued) instead of interrupting the starter or spawning a PM.
    const mailTo = this.ports.settings().runsMailTo?.trim();
    const stage = run.pm.pending?.stage ?? run.stage ?? "?";
    const detail = `Stage "${stage}" is exhausted: ${run.pm.pending?.reason ?? "out of attempts"}.\nLast summary: ${run.stages[stage]?.summary ?? "none"}\nThis is the run's ONE judgement on this stage: if it exhausts again after your extra attempts, the run fails and goes to the human.`;
    if (mailTo && this.ports.report) {
      // Decision c8125131: the PM is paged at once; the mail (read when its reader is idle) informs, or asks when no PM came.
      const paged = this.pmSettings().pageOnExhausted === true && (await this.judge(run, "exhausted", stage, detail));
      const pm = paged ? (pmCalls(run)[pmKey(run.id, "exhausted", stage, run.stages[stage]?.runs ?? 0)]?.agentId ?? "?") : null;
      const subject = paged ? `Run ${run.id} ${this.runLabel(run)}: stage ${stage} exhausted, PM ${pm} paged` : `Run ${run.id} ${this.runLabel(run)} needs PM`;
      const body = paged ? `${this.runFacts(run)}\nThe on-demand PM ${pm} was paged and judges it now; nothing is needed unless it escalates.\n${text}` : `${this.runFacts(run)}\n${text}`;
      await this.ports.report(mailTo, { subject, body, kind: "run" }).catch((e) => console.error("blueprints: PM mail failed", e));
      return;
    }
    // Otherwise an on-demand PM for this judgement key; none (no pm role, the per-run limit, a key already judged): the human.
    if (await this.judge(run, "exhausted", stage, detail)) return;
    const call = pmCalls(run)[pmKey(run.id, "exhausted", stage, run.stages[stage]?.runs ?? 0)];
    const why = call?.state === "unavailable" ? (call.outcome ?? "spawn failed") : call ? "a PM already had this point" : `pm.maxPerRun (${this.pmSettings().maxPerRun}) reached`;
    run.pm.pending = null;
    this.pause(run, stage, `exhausted (${run.stages[stage]?.summary ?? "no summary"}) and no PM could be started: ${why}`, { human: true });
  }

  // ---- the on-demand PM ----

  private pmSettings(): PmSettings {
    return { ...PM_DEFAULTS, ...(this.ports.settings().pm ?? {}) };
  }

  /** With runs.notifyMailTo set, judgement requests are mailed there and no PM is spawned. */
  private pmMode(): boolean {
    return !this.ports.settings().runsMailTo?.trim();
  }

  private isPmAgent(run: Run, agentId: string): boolean {
    return Object.values(run.pm.calls ?? {}).some((c) => c.agentId === agentId);
  }

  /** The run and call of a PM agent the Factory spawned. */
  private pmCallOf(agentId: string): { run: Run; call: PmCall } | null {
    for (const run of this.store.all()) for (const call of Object.values(run.pm.calls ?? {})) if (call.agentId === agentId) return { run, call };
    return null;
  }

  /** The run a Factory PM was spawned for (it may act only on it and its child runs), or null for any other agent. */
  pmRunOf(agentId: string): string | null {
    return this.pmCallOf(agentId)?.run.id ?? null;
  }

  /** May this agent answer this Inbox item? Only the live PM of a `pm = true` gate, for that gate's item. */
  pmMayAnswer(agentId: string, itemId: string): boolean {
    const found = this.pmCallOf(agentId);
    if (!found || !pmLive(found.call) || found.call.point !== "gate" || !itemId || found.call.gateItemId !== itemId) return false;
    const def = found.run.def.stage.find((s) => s.id === found.call.stage);
    return def?.kind === "gate" && (def as GateStage).pm === true;
  }

  /**
   * A judgement point: spawn the PM of its key (`<run>:<point>:<stage>:<entry>`). True when a PM has it (just spawned, or one of
   * the same key still live); false when the caller must go to the human: a key that already had its PM, the per-run limit, or
   * no PM could be started.
   */
  private async judge(run: Run, point: PmPoint, stage: string, detail: string, extra: { gateItemId?: string } = {}): Promise<boolean> {
    const key = pmKey(run.id, point, stage, run.stages[stage]?.runs ?? 0);
    const calls = pmCalls(run);
    if (calls[key]) return pmLive(calls[key]);
    const s = this.pmSettings();
    const count = Object.keys(calls).length;
    if (count >= s.maxPerRun) {
      this.log(run, "pm_limit", stage, `${count} PMs already (pm.maxPerRun ${s.maxPerRun}): ${point} goes to the human`);
      this.store.save();
      return false;
    }
    const now = this.ports.now();
    const call: PmCall = { key, point, stage, entry: run.stages[stage]?.runs ?? 0, agentId: null, startedAt: now, endedAt: null, state: "active", gateItemId: extra.gateItemId ?? null, escalation: null, outcome: null };
    calls[key] = call;
    this.store.save();
    const role = this.ports.settings().pmRole;
    try {
      const prompt = pmPrompt({ run, call, detail, pmExtraMax: run.def.pm_extra_max, timeoutMinutes: s.timeoutMinutes, digest: buildDigest(run, { now, spend: this.ports.spend?.(run.id) ?? null, janitor: [] }), prFacts: await this.prFactLines(run) });
      const { agentId, workspaceId } = await this.ports.spawn({
        idempotencyKey: `pm:${key}`,
        role,
        prompt,
        title: pmTitle(run, point),
        workspaceTitle: workspaceTitle(role, run.vars, `${run.blueprint} ${run.id}`, customLabel(run)),
        cwd: this.ports.settings().defaultCwd,
        labels: { "paseo.factory": "1", "paseo.factory.blueprint": run.blueprint, "paseo.factory.run": run.id, "paseo.factory.role": role, "paseo.factory.stage": "pm", "paseo.factory.pm.point": point },
        env: { PASEO_AGENT_ROLE: role, PASEO_FACTORY_RUN: run.id, PASEO_FACTORY_STAGE: "pm" },
      });
      call.agentId = agentId;
      run.pmAgentId = agentId;
      this.registerAgent(run, agentId, role, "pm", workspaceId);
      this.log(run, "pm_spawned", stage, `${point}: ${agentId} (${key})`);
      this.store.save();
      return true;
    } catch (error) {
      call.state = "unavailable";
      call.endedAt = this.ports.now();
      call.outcome = (error as Error).message;
      this.log(run, "pm_unavailable", stage, `${point}: ${clip((error as Error).message, 300)}`);
      this.store.save();
      return false;
    }
  }

  private async prFactLines(run: Run): Promise<string[]> {
    const out: string[] = [];
    for (const url of this.prUrls(run, undefined).slice(0, 10)) {
      try {
        const f = await this.ports.prFacts(url);
        out.push(`- ${url}: ${f.state}${f.draft ? " (draft)" : ""}, head ${f.head.slice(0, 12)}, CI ${f.ci}, mergeable ${f.mergeable === null ? "unknown" : f.mergeable}, review ${f.review || "none"}`);
      } catch (error) {
        out.push(`- ${url}: facts unavailable (${(error as Error).message})`);
      }
    }
    return out;
  }

  /** Is the point the PM was spawned for still waiting for a decision? */
  private pointOpen(run: Run, call: PmCall): boolean {
    switch (call.point) {
      case "exhausted":
        return run.status === "waiting" && run.pm.pending?.stage === call.stage;
      case "resume":
        return run.status === "paused" && run.stage === call.stage;
      case "failed":
        return run.status === "failed" && call.state !== "done";
      case "gate":
        return false; // the gate is in the Inbox for the human all along
    }
  }

  /** The PM did not settle its point: ask the human as the engine did before PMs. */
  private pmToHuman(run: Run, call: PmCall, why: string): void {
    this.log(run, "pm_to_human", call.stage, `${call.point}: ${why}`);
    if (call.point === "resume") this.escalate(run, call.stage, `${run.error ?? "paused"}; the PM: ${why}`, "setup");
    else if (call.point === "exhausted") this.escalate(run, call.stage, `${run.pm.pending?.reason ?? "exhausted"}; the PM: ${why}`);
    else if (call.point === "failed") this.escalate(run, call.stage, `the run failed (${run.error ?? "no detail"}); the PM: ${why}`);
    this.store.save();
  }

  /** The PM's call is over: archive it (and its workspace); a point it left open goes to the human. */
  private async endPm(run: Run, call: PmCall, state: PmCall["state"], why: string): Promise<void> {
    if (call.endedAt !== null) return;
    const handedOver = call.state === "handover";
    call.state = state;
    call.endedAt = this.ports.now();
    call.outcome ??= why;
    call.escalation = null;
    this.log(run, "pm_ended", call.stage, `${call.point} ${call.agentId ?? "?"}: ${state} (${clip(why, 200)})`);
    this.store.save();
    if (call.agentId) {
      if ((await this.ports.agentState(call.agentId).catch(() => "gone" as const)) !== "gone") await this.ports.archive(call.agentId).catch((e) => console.error(`blueprints: archiving PM ${call.agentId} failed`, e));
      await this.archiveWorkspaceOf(run, call.agentId);
    }
    if (!handedOver && this.pointOpen(run, call)) this.pmToHuman(run, call, why);
    this.store.save();
  }

  /** A PM's turn ended: it is archived, unless it waits for the answer to its escalation. Over-budget spend is flagged. */
  pmTurnEnded(agentId: string): Promise<void> {
    const found = this.pmCallOf(agentId);
    if (!found || found.call.endedAt !== null) return Promise.resolve();
    const { run, call } = found;
    return this.exclusive(run.id, async () => {
      if (call.endedAt !== null) return;
      const cost = this.ports.spendOfAgent?.(agentId);
      const max = this.pmSettings().maxUsd;
      if (cost !== undefined && max > 0 && cost > max) this.log(run, "pm_over_budget", call.stage, `$${cost.toFixed(2)} > $${max.toFixed(2)} (${call.key})`);
      if (call.state === "escalated") {
        this.log(run, "pm_waiting", call.stage, `waiting for ${call.escalation?.target ?? "an answer"}`);
        this.store.save();
        return;
      }
      await this.endPm(run, call, call.state === "active" ? "done" : call.state, call.state === "active" ? "turn ended without blueprint_pm_done" : (call.outcome ?? "done"));
    }).catch((e) => console.error(`blueprints: PM turn of ${agentId}`, e));
  }

  private requirePm(callerId: string, runId: string): { run: Run; call: PmCall } {
    const found = this.pmCallOf(callerId);
    if (!found || found.run.id !== runId || !pmLive(found.call)) throw new UsageError(`You are not the live PM of run ${runId}.`);
    return found;
  }

  /** Tell the run's waiting worker, if there is one, what the PM is doing; it is marked waiting (no nudge, no attempt). */
  private async tellWorker(run: Run, text: string): Promise<void> {
    const id = run.stage;
    const st = id ? run.stages[id] : undefined;
    if (!id || !st?.agentId || (st.status !== "running" && st.status !== "waiting")) return;
    if ((await this.ports.agentState(st.agentId).catch(() => "gone" as const)) === "gone") return;
    st.workerWaitSince ??= this.ports.now();
    run.waitingFor = clip(text, 300);
    this.log(run, "worker_told", id, clip(text, 200));
    this.store.save();
    await this.ports.send(st.agentId, `Factory: ${text}. Wait for it; no attempt is used meanwhile.`).catch((e) => console.error(`blueprints: telling the worker of ${run.id} failed`, e));
  }

  /** blueprint_pm_escalate: step 1 to the escalation target, step 2 (or no target) to the human through a blocking inbox_ask. */
  async pmEscalate(callerId: string, runId: string, input: { question: string; bestGuess: string; checked: string }): Promise<{ target: string; step: 1 | 2; how: string; wait_minutes: number | null }> {
    const { run, call } = this.requirePm(callerId, runId);
    return this.exclusive(run.id, async () => {
      if (call.escalation?.step === 2) throw new UsageError("Your question is already with the human: wait for the Inbox answer.");
      let step: 1 | 2 = call.escalation ? 2 : 1;
      let target = step === 1 ? (this.ports.escalationTarget?.() ?? "").trim() : "";
      if (!target) {
        step = 2;
        target = "human";
      }
      const wait = this.pmSettings().escalateTimeoutMinutes;
      call.escalation = { step, target, at: this.ports.now(), question: clip(input.question, 2000) };
      call.state = "escalated";
      this.log(run, "pm_escalated", call.stage, `step ${step} to ${target}: ${clip(input.question, 200)} (best guess: ${clip(input.bestGuess, 120)})`);
      this.store.save();
      await this.tellWorker(run, step === 1 ? `the run's PM asked ${target} about: ${clip(input.question, 150)}; waiting up to ${wait} min` : `the run's PM asked the human about: ${clip(input.question, 150)}`);
      return { target, step, how: escalationHow({ run, call, target, step, question: input.question, bestGuess: input.bestGuess, checked: input.checked, waitMinutes: wait }), wait_minutes: step === 1 ? wait : null };
    });
  }

  /** blueprint_pm_answer: the answer the PM got to its escalation, with who gave it. */
  async pmAnswer(callerId: string, runId: string, input: { answer: string; by: string }): Promise<{ ok: true }> {
    const { run, call } = this.requirePm(callerId, runId);
    return this.exclusive(run.id, async () => {
      if (!call.escalation) throw new UsageError("You have no escalation waiting for an answer.");
      this.log(run, "pm_answer", call.stage, `${clip(input.by, 80)} (step ${call.escalation.step}): ${clip(input.answer, 300)}`);
      call.escalation = null;
      call.state = "active";
      call.startedAt = this.ports.now(); // a fresh pm.timeoutMinutes to act on the answer
      this.store.save();
      return { ok: true as const };
    });
  }

  /** blueprint_pm_done: the PM's decision (or its handover to the human); it is archived when its turn ends. */
  async pmDone(callerId: string, runId: string, input: { summary: string; handover?: boolean }): Promise<{ ok: true; archived_at_turn_end: true }> {
    const { run, call } = this.requirePm(callerId, runId);
    return this.exclusive(run.id, async () => {
      call.escalation = null;
      call.state = input.handover ? "handover" : "done";
      call.outcome = clip(input.summary, 1000);
      this.log(run, input.handover ? "pm_handover" : "pm_done", call.stage, `${call.point}: ${clip(input.summary, 300)}`);
      if (input.handover && this.pointOpen(run, { ...call, state: "active" })) this.pmToHuman(run, call, `handed over: ${clip(input.summary, 300)}`);
      this.store.save();
      return { ok: true as const, archived_at_turn_end: true as const };
    });
  }

  /** Timeouts of the PMs: a turn past pm.timeoutMinutes, an escalation past pm.escalateTimeoutMinutes, a PM that is gone. */
  private async pmTick(now: number): Promise<void> {
    const s = this.pmSettings();
    for (const run of this.store.all()) {
      for (const call of Object.values(run.pm.calls ?? {})) {
        if (call.endedAt !== null || call.state === "unavailable") continue;
        try {
          await this.exclusive(run.id, async () => {
            if (call.endedAt !== null) return;
            const state = call.agentId ? await this.ports.agentState(call.agentId).catch(() => "gone" as const) : "gone";
            // Decided, and its turn is over (a turn_ended that a restart lost): archive it now.
            if (call.state === "done" || call.state === "handover") return state === "running" ? undefined : this.endPm(run, call, call.state, call.outcome ?? call.state);
            if (state === "gone") return this.endPm(run, call, "gone", "the PM agent is gone");
            if (call.state === "active" && now - call.startedAt >= s.timeoutMinutes * 60_000) {
              this.log(run, "pm_timeout", call.stage, `${call.point}: no decision in ${s.timeoutMinutes} min`);
              return this.endPm(run, call, "timeout", `no decision in ${s.timeoutMinutes} min`);
            }
            const esc = call.escalation;
            if (call.state === "escalated" && esc?.step === 1 && now - esc.at >= s.escalateTimeoutMinutes * 60_000) {
              this.log(run, "pm_escalation_timeout", call.stage, `${esc.target} did not answer in ${s.escalateTimeoutMinutes} min: the human is next`);
              call.escalation = { ...esc, step: 2, target: "human", at: now };
              this.store.save();
              await this.tellWorker(run, `the run's PM got no answer from ${esc.target}; it asks the human now about: ${clip(esc.question, 150)}`);
              if (call.agentId)
                await this.ports
                  .send(call.agentId, `Factory: ${esc.target} did not answer in ${s.escalateTimeoutMinutes} min. ${escalationHow({ run, call, target: "human", step: 2, question: esc.question, bestGuess: "your best guess", checked: "what you checked", waitMinutes: 0 })}`)
                  .catch((e) => console.error(`blueprints: PM ${call.agentId} not told`, e));
            }
          });
        } catch (error) {
          console.error(`blueprints: PM tick of ${run.id} failed`, error);
        }
      }
    }
  }

  /** The PM's single judgement: grant bounded extra attempts, or re-scope to another stage. */
  async retry(runId: string, input: { stage?: string; extraAttempts?: number; to?: string; note?: string }): Promise<Run> {
    const run = this.require(runId);
    return this.exclusive(run.id, async () => {
      const pending = run.pm.pending;
      if (!pending) throw new UsageError(`Run ${run.id} is not waiting for a PM judgement.`);
      const stage = input.stage ?? pending.stage;
      if (stage !== pending.stage) throw new UsageError(`The judgement asked is about stage ${pending.stage}.`);
      const max = run.def.pm_extra_max;
      const n = input.extraAttempts ?? 0;
      if (!input.to && (n < 1 || n > max)) throw new UsageError(`extra_attempts must be 1 to ${max} (pm_extra_max), or give "to" to re-scope.`);
      if (input.to && !run.def.stage.some((s) => s.id === input.to)) throw new UsageError(`No stage "${input.to}".`);
      run.pm.judged[stage] = { at: this.ports.now(), decision: input.to ? `rescope to ${input.to}` : `grant ${n}` };
      run.pm.pending = null;
      run.status = "running";
      run.waitingFor = null;
      this.withdrawEscalations(run, "PM judged the stage");
      const st = run.stages[stage];
      if (input.to) {
        const target = (run.stages[input.to] ??= freshStage());
        if (input.note) target.notes.push(input.note);
        this.log(run, "pm_rescope", stage, `to ${input.to}: ${input.note ?? ""}`);
        await this.go(run, stage, input.to, "PM re-scope");
      } else {
        st.extra += n;
        if (input.note) st.notes.push(input.note);
        this.log(run, "pm_grant", stage, `${n} extra`);
        st.status = "entering";
        this.store.save();
        // The grant covers both counters: continue where it stopped.
        if (st.runs > 0 && (this.stageDef(run, stage).kind ?? "agent") === "agent") await this.dispatch(run, stage, "retry");
        else await this.enter(run, stage);
      }
      return run;
    });
  }

  // ---- suspending ----

  /** Wake the pod of a worker (best effort: the prompt that follows wakes it anyway). */
  private async wakePod(run: Run, agentId: string): Promise<void> {
    const workspaceId = run.agents?.[agentId]?.workspaceId;
    if (!workspaceId || !this.ports.wakeWorkspace) return;
    await this.ports.wakeWorkspace(workspaceId).catch((e) => console.error(`blueprints: waking ${workspaceId} failed`, e));
  }

  /**
   * Hold a run: no worker is spawned or prompted, no stage is retried, no attempt is used, and open gates (Inbox items) stay as they
   * are. The pod of the stage's worker is suspended (volume kept) and the worker agent is kept, not archived.
   */
  async suspend(runId: string, input: { reason: string; by: string; force?: boolean; usageLimit?: UsageLimitHold }): Promise<Run> {
    const run = this.require(runId);
    return this.exclusive(run.id, () => this.doSuspend(run, input));
  }

  private async doSuspend(run: Run, input: { reason: string; by: string; force?: boolean; usageLimit?: UsageLimitHold }): Promise<Run> {
    if (run.status === "done" || run.status === "failed" || run.status === "aborted") throw new UsageError(`Run ${run.id} is already ${run.status}.`);
    if (run.status === "suspended") return run;
    const now = this.ports.now();
    const pods: string[] = [];
    run.suspended = { reason: input.reason, at: now, by: input.by, prevStatus: run.status, pods, ...(input.usageLimit ? { usageLimit: input.usageLimit } : {}) };
    run.status = "suspended";
    // The Warden would prompt a quiet worker: its watch ends here and the stage registers a new one when it is woken.
    for (const st of Object.values(run.stages)) {
      if (st.wardenTask) {
        this.ports.wardenDone(st.wardenTask, "run suspended");
        st.wardenTask = null;
      }
    }
    this.log(run, "suspended", run.stage, `${input.reason} (by ${input.by})`);
    this.store.save();
    const st = run.stage ? run.stages[run.stage] : undefined;
    const def = run.stage ? this.stageDef(run, run.stage) : undefined;
    const workspaceId = st?.agentId ? run.agents?.[st.agentId]?.workspaceId : null;
    if (st?.status === "running" && (def?.kind ?? "agent") === "agent" && st.agentId) {
      if (!workspaceId) pods.push(`worker ${st.agentId}: local, not prompted any more`);
      else if (!this.ports.suspendWorkspace) pods.push(`worker ${st.agentId}: pod ${workspaceId} not suspended (the runtime offers no workspace control)`);
      else {
        const out = await this.ports.suspendWorkspace(workspaceId, !!input.force).catch((e: Error) => ({ ok: false, message: e.message }));
        pods.push(`worker ${st.agentId}: pod ${workspaceId} ${out.ok ? "suspended" : `not suspended (${out.message ?? "refused"})`}`);
      }
      this.store.save();
    }
    return run;
  }

  /** Suspend the whole Factory: the state survives a reload, runs started later are refused, and every live run is suspended. */
  async suspendAll(input: { reason: string; by: string; force?: boolean }): Promise<Run[]> {
    if (!this.store.suspended()) this.store.setSuspended({ reason: input.reason, at: this.ports.now(), by: input.by });
    const out: Run[] = [];
    for (const run of this.store.all().filter((r) => r.status === "running" || r.status === "waiting" || r.status === "paused")) {
      out.push(await this.suspend(run.id, input).catch((e) => {
        console.error(`blueprints: suspending ${run.id} failed`, e);
        return run;
      }));
    }
    return out;
  }

  /** Continue a suspended run at the same stage and attempt count. */
  async unsuspend(runId: string, input: { note?: string } = {}): Promise<Run> {
    const run = this.require(runId);
    return this.exclusive(run.id, () => this.doUnsuspend(run, input));
  }

  private async doUnsuspend(run: Run, input: { note?: string }): Promise<Run> {
    if (run.status !== "suspended") throw new UsageError(`Run ${run.id} is ${run.status}, not suspended.`);
    const usage = !!run.suspended?.usageLimit;
    run.status = run.suspended?.prevStatus ?? "running";
    run.suspended = null;
    const id = run.stage;
    const st = id ? run.stages[id] : undefined;
    if (input.note && st) st.notes.push(input.note);
    if (usage && st) st.wakeReason = "usage_limit";
    this.log(run, "unsuspended", id, input.note ?? null);
    this.store.save();
    if (id && st) await this.replay(run, id, st, { resumed: true });
    return run;
  }

  /** Resume every suspended run, at most `concurrency` at a time; the Factory-wide hold is lifted first. `done` settles when all are going. */
  resumeAllSuspended(input: { concurrency?: number; note?: string } = {}): { runs: string[]; done: Promise<void> } {
    this.store.setSuspended(null);
    const queue = this.store.all().filter((r) => r.status === "suspended").map((r) => r.id);
    const runs = [...queue];
    const width = Math.max(1, Math.min(input.concurrency ?? 2, queue.length || 1));
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await this.unsuspend(id, { note: input.note }).catch((e) => console.error(`blueprints: resuming ${id} failed`, e));
    };
    return { runs, done: Promise.all(Array.from({ length: width }, worker)).then(() => undefined) };
  }

  /** After a person decided: continue a failed, paused or PM-waiting run at a stage with fresh attempts. */
  async resume(runId: string, input: { stage?: string; extraAttempts?: number; note?: string; attachAgent?: string }): Promise<Run> {
    const run = this.require(runId);
    return this.exclusive(run.id, () => (run.status === "suspended" ? this.doUnsuspend(run, { note: input.note }) : this.doResume(run, input)));
  }

  private async doResume(run: Run, input: { stage?: string; extraAttempts?: number; note?: string; attachAgent?: string }): Promise<Run> {
    {
      if (run.status === "done" || run.status === "aborted") throw new UsageError(`Run ${run.id} is ${run.status}; start a new one.`);
      const stage = input.stage ?? run.pm.pending?.stage ?? run.stage;
      if (!stage) throw new UsageError("Name the stage to resume at.");
      const def = this.stageDef(run, stage);
      const attach = input.attachAgent;
      if (attach) {
        if ((def.kind ?? "agent") !== "agent") throw new UsageError(`Stage ${stage} is not an agent stage: there is no worker to attach.`);
        const known = run.agents?.[attach];
        if (!known) throw new UsageError(`Agent ${attach} is not a worker of run ${run.id}.`);
        if (known.role !== (def as AgentStage).role) throw new UsageError(`Agent ${attach} runs as ${known.role}, stage ${stage} needs ${(def as AgentStage).role}.`);
        if ((await this.ports.agentState(attach)) === "gone") throw new UsageError(`Agent ${attach} is gone; resume without attach_agent to get a new worker.`);
        const busy = this.store.active().find((r) => Object.entries(r.stages).some(([sid, other]) => (r.id !== run.id || sid !== stage) && other.agentId === attach && (other.status === "running" || other.status === "entering")));
        if (busy) throw new UsageError(`Agent ${attach} is the worker of another running stage (run ${busy.id}).`);
      }
      // A gate tied to PRs reads them as it opens: read them first (quick retries), so a GitHub outage refuses the resume
      // with the run left exactly as it was, instead of half-resuming it (bp-98295f48: "gh: HTTP 500" twice).
      if (def.kind === "gate" && (def as GateStage).pr) {
        for (const url of this.r(run, (def as GateStage).pr!).split(",").map((x) => x.trim()).filter(Boolean)) {
          try {
            await this.freshFacts(url);
          } catch (error) {
            if (error instanceof GitHubUnavailableError) throw new RetryLaterError(`Run ${run.id} not resumed: ${error.message}`);
            throw error;
          }
        }
      }
      const st = (run.stages[stage] ??= freshStage());
      st.extra += Math.max(0, input.extraAttempts ?? 0);
      if (input.note) st.notes.push(input.note);
      run.status = "running";
      run.error = null;
      run.endedAt = null;
      run.pm.pending = null;
      run.waitingFor = null;
      this.withdrawEscalations(run, "run resumed");
      this.log(run, "resumed", stage, input.note ?? null);
      st.status = "entering";
      st.attempts = 0;
      this.store.save();
      await this.enter(run, stage, attach ? { attach } : {});
      return run;
    }
  }

  async abort(runId: string, reason: string): Promise<Run> {
    const run = this.require(runId);
    return this.exclusive(run.id, async () => {
      if (run.status === "done" || run.status === "failed" || run.status === "aborted") throw new UsageError(`Run ${run.id} is already ${run.status}.`);
      this.finish(run, "aborted", reason);
      return run;
    });
  }

  // ---- agent stages ----

  private composePrompt(run: Run, id: string, def: AgentStage, st: StageState, why: "start" | "nudge" | "retry" | "wake", facts: string, o: { callVerdict?: boolean } = {}): string {
    const parts: string[] = [];
    if (why === "wake" && st.wakeReason === "usage_limit") {
      parts.push(`Factory: the provider usage limit was lifted and run ${run.id} is resumed. Continue stage "${id}" where you stopped (check the repository and PR state first), then call blueprint_verdict. Do not end your turn without it.`);
    } else if (why === "wake") {
      parts.push(`Factory: run ${run.id} was suspended and is resumed. Continue stage "${id}" where you stopped (check the repository and PR state first), then call blueprint_verdict. Do not end your turn without it.`);
    } else if (why === "nudge" && o.callVerdict) {
      parts.push(
        `Factory: CALL YOUR VERDICT NOW. You ended your turn without blueprint_verdict for stage "${id}" of run ${run.id}. ` +
          `If the work is done, or you cannot go further, call blueprint_verdict right away with the verdict that fits and a summary of where things stand (blocked is a verdict). ` +
          `If you are waiting on a person or an outside system, call blueprint_waiting instead. This reminder uses no attempt; the next turn that ends without a verdict uses one.`,
      );
    } else if (why === "nudge") {
      parts.push(`Factory: you ended your turn without giving a verdict for stage "${id}" of run ${run.id}. Finish the work if needed, then call blueprint_verdict. Do not end your turn without it.`);
    } else {
      parts.push(this.r(run, def.prompt));
    }
    if (st.notes.length) parts.push(`## Notes from the PM\n${st.notes.map((n) => `- ${n}`).join("\n")}`);
    if ((why === "retry" || why === "wake") && st.progress?.length) parts.push(progressBlock(st.progress));
    if (facts) parts.push(facts);
    const verdicts = stageVerdicts(def);
    parts.push(
      `## Factory stage\nYou are stage \`${id}\` (role ${def.role}) of blueprint \`${run.blueprint}\`, run \`${run.id}\`.\n` +
        `When you are done, call the MCP tool blueprint_verdict(run="${run.id}", stage="${id}", verdict=one of [${verdicts.join(", ")}], summary="...", data={...}) and then stop. ` +
        `The verdict picks what happens next. Attempt ${st.attempts} of ${def.max_attempts + st.extra}.`,
    );
    return parts.join("\n\n");
  }

  private async prFactsBlock(run: Run, def: AgentStage): Promise<string> {
    if (def.facts !== "pr") return "";
    const urls = this.prUrls(run, def.pr_urls_from);
    if (urls.length === 0) return "";
    const lines: string[] = [];
    for (const url of urls) {
      try {
        const f = await this.ports.prFacts(url);
        lines.push(`- ${url}: ${f.state}${f.draft ? " (draft)" : ""}, head ${f.head.slice(0, 12)}, CI ${f.ci}, mergeable ${f.mergeable === null ? "unknown" : f.mergeable}, review ${f.review || "none"}`);
      } catch (error) {
        lines.push(`- ${url}: facts unavailable (${(error as Error).message})`);
      }
    }
    return `## PR facts (read by the Factory just now, not reported by a worker)\n${lines.join("\n")}`;
  }

  private prUrls(run: Run, from: string | undefined): string[] {
    const sources = from ? [from] : Object.keys(run.stages);
    const out = new Set<string>();
    for (const s of sources) {
      const urls = run.stages[s]?.data.pr_urls;
      if (Array.isArray(urls)) for (const u of urls) if (typeof u === "string") out.add(u);
    }
    return [...out];
  }

  /**
   * Archive the worker a stage no longer uses, unless another stage still holds it. One that is mid-turn is archived when
   * its turn ends (`turnEnded`), not cut off.
   */
  private async retire(run: Run, stage: string, agentId: string): Promise<void> {
    if (Object.entries(run.stages).some(([sid, other]) => sid !== stage && other.agentId === agentId && (other.status === "running" || other.status === "entering" || other.status === "waiting"))) return;
    if (run.pmAgentId === agentId) return;
    const state = await this.ports.agentState(agentId).catch(() => "gone" as const);
    if (state === "running") {
      const list = (run.retiring ??= []);
      if (!list.includes(agentId)) list.push(agentId);
      this.log(run, "retiring", stage, `${agentId} is mid-turn: archived when its turn ends`);
      this.store.save();
      return;
    }
    if (state !== "gone") await this.ports.archive(agentId).catch((e) => console.error(`blueprints: archiving ${agentId} failed`, e));
    await this.archiveWorkspaceOf(run, agentId);
  }

  /**
   * Archive the workspace (pod, volume, Sandbox object) of a worker that was just archived, or the Kubernetes quota fills up with
   * suspended pods. Dirty or unpushed work does not keep it (human rule 2026-10-28: "force the archive of workspace after the
   * deletion of the agent, even if there is still code"); the history records `git status --short` when the pod answers in 5 s.
   * Only a workspace that is still in use is left (the run's shared workspace while the run goes, an agent of a live stage or
   * another live agent in it): the orphan sweep archives it once it is not.
   */
  private async archiveWorkspaceOf(run: Run, agentId: string): Promise<void> {
    const ws = run.agents?.[agentId]?.workspaceId;
    if (!ws || run.agents?.[agentId]?.workspaceArchived || !this.ports.archiveWorkspace) return;
    try {
      if (run.sharedWorkspaceId === ws && run.endedAt === null) return;
      const inUse = Object.entries(run.agents ?? {}).some(
        ([id, a]) => id !== agentId && a.workspaceId === ws && (run.pmAgentId === id || Object.values(run.stages).some((st) => st.agentId === id && (st.status === "running" || st.status === "entering" || st.status === "waiting"))),
      );
      if (inUse) return;
      if (this.ports.liveAgentsIn) {
        const live = (await this.ports.liveAgentsIn(ws))?.filter((id) => id !== agentId);
        if (!live || live.length) return;
      }
      const trace = await this.traceOf(ws);
      await this.ports.archiveWorkspace(ws);
      for (const a of Object.values(run.agents ?? {})) if (a.workspaceId === ws) a.workspaceArchived = true;
      this.log(run, "workspace_archived", null, `${ws} of ${agentId} (worktree: ${trace})`);
    } catch (error) {
      console.error(`blueprints: archiving workspace ${ws} of ${agentId} failed (the orphan sweep retries)`, error);
    }
  }

  /** `git status --short` for the history: 5 s at most, whatever the port does. */
  private async traceOf(ws: string): Promise<string> {
    if (!this.ports.trace) return "not traced";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.ports.trace(ws), new Promise<string>((resolve) => (timer = setTimeout(() => resolve("no answer (5 s)"), 5_000)))]);
    } catch {
      return "no answer";
    } finally {
      clearTimeout(timer);
    }
  }

  /** The run ended: its workers (not the PM) and their workspaces are of no use any more. The janitor does this after the retro when it is on. */
  private async retireWorkers(run: Run): Promise<void> {
    for (const id of Object.keys(run.agents ?? {})) {
      if (id === run.pmAgentId) continue;
      const state = await this.ports.agentState(id).catch(() => "gone" as const);
      if (state === "running") {
        const list = (run.retiring ??= []);
        if (!list.includes(id)) list.push(id);
        this.log(run, "retiring", null, `${id} is mid-turn: archived when its turn ends`);
        this.store.save();
        continue;
      }
      if (state !== "gone") await this.ports.archive(id).catch((e) => console.error(`blueprints: archiving ${id} failed`, e));
      await this.archiveWorkspaceOf(run, id);
    }
  }

  /**
   * The orphan sweep (every 5 minutes, human request 2026-10-28): archive the Factory's workers that no stage of an active
   * run refers to any more (replaced, superseded, or of a run that ended), and their workspaces, dirty or not. The PM, every
   * active stage's current agent (a later stage may reuse it), a mid-turn worker and a retro still writing are left alone.
   * Each archive is logged in the run's history. Returns what it archived.
   */
  async sweepOrphans(): Promise<string[]> {
    const done: string[] = [];
    for (const run of this.store.all()) {
      const current = new Set<string>();
      if (run.pmAgentId) current.add(run.pmAgentId);
      if (run.endedAt === null) for (const st of Object.values(run.stages)) if (st.agentId) current.add(st.agentId);
      if (run.post?.phase === "retro" && run.post.retro?.agentId) current.add(run.post.retro.agentId);
      for (const [id, a] of Object.entries(run.agents ?? {})) {
        if (current.has(id) || a.workspaceArchived || run.retiring?.includes(id)) continue;
        const state = await this.ports.agentState(id).catch(() => "gone" as const);
        if (state === "running") continue;
        if (state !== "gone") {
          try {
            await this.ports.archive(id);
          } catch (error) {
            console.error(`blueprints: orphan sweep could not archive ${id}`, error);
            continue;
          }
          this.log(run, "orphan_archived", a.stage, `${id} (${a.role}): no stage of the run refers to it`);
          done.push(id);
        }
        if (!a.workspaceId) continue;
        await this.archiveWorkspaceOf(run, id);
        if (run.agents?.[id]?.workspaceArchived) done.push(a.workspaceId);
      }
      this.store.save();
    }
    return done;
  }

  /** Archive the retired workers of `agentId`'s run whose turn is over (`agentId` only, or all of them when absent). */
  private async flushRetired(agentId?: string): Promise<void> {
    for (const run of this.store.all()) {
      if (!run.retiring?.length) continue;
      for (const id of [...run.retiring]) {
        if (agentId && id !== agentId) continue;
        if (!agentId && (await this.ports.agentState(id).catch(() => "gone" as const)) === "running") continue;
        run.retiring = run.retiring.filter((x) => x !== id);
        this.store.save();
        await this.ports.archive(id).catch((e) => console.error(`blueprints: archiving ${id} failed`, e));
        await this.archiveWorkspaceOf(run, id);
      }
    }
  }

  /**
   * Is this a worker the Factory spawned that no live stage of its run refers to any more? Such an agent does not count
   * against its role's `maxConcurrent`. An agent the Factory does not know is never superseded.
   */
  isSuperseded(agentId: string): boolean {
    const run = this.store.all().find((r) => r.agents?.[agentId]);
    if (!run) return false;
    if (run.endedAt !== null) return true;
    if (run.pmAgentId === agentId) return false;
    return !Object.values(run.stages).some((st) => st.agentId === agentId && (st.status === "running" || st.status === "entering" || st.status === "waiting"));
  }

  /**
   * A worker that ended its turn (or went idle) without a verdict. Decision c8125131: the first time in an attempt it gets ONE
   * explicit "call your verdict" nudge that uses no attempt; the next one is an ordinary nudge, which counts.
   */
  private nudge(run: Run, id: string): Promise<void> {
    const st = run.stages[id];
    if (this.ports.settings().verdictNudge && !st.verdictNudged) {
      st.verdictNudged = true;
      this.log(run, "verdict_nudge", id, "no verdict: one explicit reminder, no attempt used");
      return this.dispatch(run, id, "nudge", { free: true, callVerdict: true });
    }
    return this.dispatch(run, id, "nudge");
  }

  private async dispatch(run: Run, id: string, why: "start" | "nudge" | "retry" | "wake", opts: { free?: boolean; fresh?: boolean; archiveOld?: boolean; attach?: string; callVerdict?: boolean } = {}): Promise<void> {
    if (run.status === "suspended") return;
    const def = this.stageDef(run, id) as AgentStage;
    const st = run.stages[id];
    if (why === "start" || why === "retry") st.workerWaitSince = null;
    if (!opts.free) {
      st.attempts += 1;
      // A new attempt gets its own free verdict reminder (the counted nudge itself is the start of one).
      if (why !== "start") st.verdictNudged = false;
    }
    if (st.attempts > def.max_attempts + st.extra) return this.exhausted(run, id, `${st.attempts - 1} attempts used (max_attempts ${def.max_attempts})`);
    st.status = "entering";
    st.verdict = null;
    this.store.save();

    const facts = await this.prFactsBlock(run, def);
    let prompt = this.composePrompt(run, id, def, st, why, facts, { callVerdict: opts.callVerdict });
    if (why === "wake") st.wakeReason = null;
    const reuse = /^reuse:(.+)$/.exec(def.agent)?.[1];
    // A stage entered fresh gets a new worker; nudges and retries within the entry stay with its worker.
    let target: string | null = why === "start" ? null : st.agentId;
    if (reuse) target = run.stages[reuse]?.agentId ?? null;
    if (opts.fresh) target = null; // an infrastructure flake: the worker's pod is not to be trusted
    if (opts.attach) target = opts.attach; // the Assistant chose a live worker for this stage
    if (target && (await this.ports.agentState(target)) === "gone") target = null;
    if (why === "wake") {
      // Wake the pod ahead of the prompt; a worker that is gone gets a fresh start with the original prompt instead.
      if (target) await this.wakePod(run, target);
      else prompt = this.composePrompt(run, id, def, st, "retry", facts);
    }

    let freshWorkspace: string | null = null;
    try {
      if (target) {
        const previous = st.agentId;
        st.agentId = target;
        if (opts.attach) {
          this.registerAgent(run, target, def.role, id, run.agents?.[target]?.workspaceId);
          this.log(run, "attached", id, `${target}${previous && previous !== target ? ` (instead of ${previous})` : ""}`);
          if (previous && previous !== target) await this.retire(run, id, previous);
        }
        await this.ports.send(target, prompt);
        this.log(run, "sent", id, `to ${target}${reuse ? ` (reuse of ${reuse})` : ""}`);
      } else {
        const old = reuse ? run.stages[reuse]?.agentId : st.agentId;
        const replaced = !!old;
        const share = !!this.ports.settings().shareWorkspace && def.workspace === "run";
        const spawned = await this.ports.spawn({
          idempotencyKey: `${run.id}:${id}:${st.runs}:${st.attempts}${st.flakes ? `:f${st.flakes}` : ""}${st.worktreeFailures ? `:w${st.worktreeFailures}` : ""}`,
          role: def.role,
          prompt: replaced ? `${prompt}\n\nNote: the worker that held this role earlier is gone; you are its replacement. Read the repository and PR state before continuing.` : prompt,
          title: `${run.blueprint} · ${id} · ${runLabel(run)}`,
          workspaceTitle: workspaceTitle(def.role, run.vars, `${run.blueprint} ${run.id}`, customLabel(run)),
          cwd: def.cwd ? this.r(run, def.cwd) : this.ports.settings().defaultCwd,
          joinWorkspaceId: share ? (run.sharedWorkspaceId ?? undefined) : undefined,
          labels: {
            "paseo.factory": "1",
            "paseo.factory.blueprint": run.blueprint,
            "paseo.factory.run": run.id,
            "paseo.factory.stage": id,
            "paseo.factory.role": def.role,
          },
          env: { PASEO_AGENT_ROLE: def.role, PASEO_FACTORY_RUN: run.id, PASEO_FACTORY_STAGE: id },
        });
        st.agentId = spawned.agentId;
        freshWorkspace = spawned.workspaceId ?? null;
        this.registerAgent(run, spawned.agentId, def.role, id, spawned.workspaceId);
        if (share && spawned.workspaceId) run.sharedWorkspaceId = spawned.workspaceId;
        this.log(run, "spawned", id, `${def.role} ${spawned.agentId}`);
        // The worker this one replaces is of no use any more (and counts against the role's limit while it lives).
        if (old && old !== spawned.agentId && (!reuse || opts.archiveOld)) await this.retire(run, id, old);
      }
    } catch (error) {
      // No room in the namespace (quota on pods, sandboxes...), or a daemon too loaded to answer a plugin hook in time: nothing is
      // wrong with the stage, so no attempt is used and nobody is asked (a busy daemon only up to MAX_BUSY_RETRIES times).
      const quota = isQuotaError((error as Error).message);
      const gitTimeout = !quota && isGitTimeout((error as Error).message);
      if (gitTimeout && (st.quotaRetry?.n ?? 0) + 1 >= MAX_GIT_TIMEOUTS) {
        if (!opts.free) st.attempts = Math.max(0, st.attempts - 1);
        st.summary = `the daemon's git timed out ${(st.quotaRetry?.n ?? 0) + 1} times in a row starting the worker: ${clip((error as Error).message, 300)}`;
        st.quotaRetry = null;
        this.log(run, "git_timeout_pause", id, st.summary);
        const mailTo = this.ports.post?.().eventsMailTo?.trim();
        if (mailTo && this.ports.report) void this.ports.report(mailTo, { subject: `Run ${run.id} ${this.runLabel(run)}: git timed out repeatedly at ${id}`, body: `${st.summary}\nThe run is paused; resume it once the daemon's git answers.\n${this.runFacts(run)}`, kind: "run" }).catch(() => undefined);
        return this.pause(run, id, st.summary);
      }
      const busy = !quota && isBusyError((error as Error).message) && (st.quotaRetry?.n ?? 0) < MAX_BUSY_RETRIES;
      if (quota || busy) {
        const n = (st.quotaRetry?.n ?? 0) + 1;
        const wait = quotaBackoffMs(n);
        if (!opts.free) st.attempts = Math.max(0, st.attempts - 1);
        st.quotaRetry = { n, at: this.ports.now() + wait, why, opts: { free: opts.free, fresh: opts.fresh, archiveOld: opts.archiveOld, attach: opts.attach } };
        st.summary = `${quota ? "waiting for cluster quota" : "the daemon is busy"} (retry ${n} in ${Math.round(wait / 60_000)} min)`;
        this.log(run, quota ? "quota_wait" : "busy_wait", id, `${clip((error as Error).message, 300)}; no attempt used, retry ${n} in ${Math.round(wait / 60_000)} min`);
        this.store.save();
        return;
      }
      const flake = flakeReason((error as Error).message);
      // Two pod starts in a row that failed: alert instead of spending more retries (human decision d82771ac).
      if (isStartFailure(flake)) {
        st.podStartFailures = (st.podStartFailures ?? 0) + 1;
        if (st.podStartFailures >= MAX_POD_START_FAILURES) {
          const message = (error as Error).message;
          st.attempts = Math.max(0, st.attempts - 1);
          st.summary = `the worker's pod failed to start ${st.podStartFailures} times in a row (${flake}): ${clip(message, 300)}`;
          this.log(run, "pod_start_failed", id, st.summary);
          st.podStartFailures = 0;
          const mailTo = this.ports.post?.().eventsMailTo?.trim();
          if (mailTo && this.ports.report) void this.ports.report(mailTo, { subject: `Run ${run.id} ${this.runLabel(run)}: pod start failed twice at ${id}`, body: `${st.summary}\nThe run is paused; resume it once the cluster is healthy.\n${this.runFacts(run)}`, kind: "run" }).catch(() => undefined);
          return this.pause(run, id, st.summary);
        }
      }
      if (flake && this.takeFlake(run, id, flake, (error as Error).message)) {
        // A nudge or wake-up that never reached a worker whose session is gone costs nothing: the fresh worker is the same attempt.
        if (flake === SESSION_GONE && !opts.free && (why === "nudge" || why === "wake")) st.attempts = Math.max(0, st.attempts - 1);
        return this.dispatch(run, id, "retry", { free: true, fresh: true, archiveOld: flake === SESSION_GONE });
      }
      // A worker that cannot even be started is a setup problem (working directory, role, provider), not a failed
      // attempt: retrying burns the caps in milliseconds. Pause the run with the reason and tell a person.
      const message = (error as Error).message;
      this.log(run, "dispatch_failed", id, message);
      st.attempts = Math.max(0, st.attempts - 1);
      st.summary = `could not start a worker: ${message}`;
      return this.pause(run, id, st.summary);
    }
    if (def.worktree_check && freshWorkspace && st.agentId && this.ports.worktreeCheck) {
      const failed = await this.checkWorktree(run, id, st.agentId, freshWorkspace, def.worktree_check, def.worktree_boot_grace);
      if (failed) {
        if ((st.worktreeFailures ?? 0) < 2) return this.dispatch(run, id, "retry", { free: true, fresh: true });
        st.worktreeFailures = 0;
        st.summary = `the worker's worktree failed its check twice in a row: ${failed}`;
        return this.pause(run, id, st.summary);
      }
    }
    st.status = "running";
    st.quotaRetry = null;
    st.podStartFailures = 0;
    if (st.wardenTask) this.ports.wardenDone(st.wardenTask, "redispatched");
    st.wardenTask = st.agentId ? this.ports.wardenRegister({ agentId: st.agentId, task: `blueprint ${run.blueprint} run ${run.id} stage ${id}: call blueprint_verdict when done` }) : null;
    this.store.save();
  }

  /**
   * Decision 12885996: a fresh worker whose checkout does not answer git within the stage's `worktree_check` seconds would hang its
   * stage. Its agent and workspace go, and the failure is counted; the caller starts one fresh worker, then pauses the run.
   * The `seconds` start once the workspace is up (`bootSeconds` at most): a cold pod still booting is not a git stall, and a
   * workspace that never came up was not probed, so neither counts as a failure (the warden still watches the worker).
   * Returns why it failed, or null when the worktree answered or could not be checked.
   */
  private async checkWorktree(run: Run, id: string, agentId: string, workspaceId: string, seconds: number, bootSeconds?: number): Promise<string | null> {
    const st = run.stages[id];
    const out: { ok: boolean; detail: string; unchecked?: boolean } = await this.ports
      .worktreeCheck!(workspaceId, seconds * 1000, bootSeconds === undefined ? undefined : bootSeconds * 1000)
      .catch((e: Error) => ({ ok: false, detail: e.message }));
    if (out.ok) {
      this.log(run, "worktree_ok", id, `${agentId}: ${out.detail}`);
      return null;
    }
    if (out.unchecked) {
      this.log(run, "worktree_unchecked", id, `${agentId} (${workspaceId}): ${out.detail}; not counted as a failure`);
      return null;
    }
    st.worktreeFailures = (st.worktreeFailures ?? 0) + 1;
    this.log(run, "worktree_check_failed", id, `${agentId} (${workspaceId}), ${st.worktreeFailures}/2: ${out.detail}`);
    await this.ports.archive(agentId).catch((e) => console.error(`blueprints: archiving ${agentId} failed`, e));
    if (run.sharedWorkspaceId === workspaceId) run.sharedWorkspaceId = null;
    await this.archiveWorkspaceOf(run, agentId);
    st.agentId = null;
    this.store.save();
    return out.detail;
  }

  /**
   * Records an infrastructure failure of the stage's worker and says whether it is retried for free: the stage's `flake_retries`
   * (or the `flakeRetries` setting, whichever is higher) bounds them; past it they count as attempts, as before.
   */
  private takeFlake(run: Run, id: string, reason: string, detail: string): boolean {
    const def = this.stageDef(run, id) as AgentStage;
    const st = run.stages[id];
    (st.flakeReasons ??= []).push(reason);
    const max = Math.max(def.flake_retries, this.ports.settings().flakeRetries ?? 3);
    if (st.flakes >= max) return false;
    st.flakes += 1;
    this.log(run, "flake_retry", id, `${st.flakes}/${max} ${reason}: ${detail}`);
    return true;
  }

  /** A turn failed or the worker vanished. Infrastructure failures are retried for free (see takeFlake), then it is an attempt. */
  private async agentFailed(run: Run, id: string, detail: string, failure?: ProviderFailure): Promise<void> {
    const def = this.stageDef(run, id) as AgentStage;
    const st = run.stages[id];
    const ul = failure && this.usageLimits?.enabled() ? this.usageLimits : null;
    const c = ul ? ul.classify(failure!) : null;
    if (ul && c?.kind === "usage_limit") return this.holdForUsageLimit(run, id, failure!, c);
    const reason = flakeReason(detail);
    if (ul && c?.kind === "other" && c.rule === null && !reason && !isBusyError(detail)) {
      try {
        ul.unknown({ runId: run.id, agentId: st.agentId, failure: failure! });
      } catch (error) {
        console.error("blueprints: usage-limit alert failed", error);
      }
    }
    if (reason) {
      if (this.takeFlake(run, id, reason, detail)) return this.dispatch(run, id, "retry", { free: true, fresh: true, archiveOld: reason === SESSION_GONE });
    } else if (st.flakes < def.flake_retries) {
      // Legacy: a stage that sets flake_retries retries any failed turn (provider errors) for free.
      st.flakes += 1;
      this.log(run, "flake_retry", id, `${st.flakes}/${def.flake_retries}: ${detail}`);
      return this.dispatch(run, id, "retry", { free: true });
    }
    return this.dispatch(run, id, "nudge");
  }

  /**
   * A provider usage limit: the run is held ("paused: quota") at the same stage and attempt count; no attempt, flake, nudge or
   * Inbox item. The controller is told outside the run's chain (it may hold other runs, or the whole Factory).
   */
  private async holdForUsageLimit(run: Run, id: string, failure: ProviderFailure, c: Extract<Classification, { kind: "usage_limit" }>): Promise<void> {
    const ul = this.usageLimits!;
    const st = run.stages[id];
    const global = ul.globalHold();
    const hold: UsageLimitHold = { source: global ? "global" : "own", rule: c.rule, evidence: c.evidence, provider: failure.provider ?? null, agentId: st.agentId, resetAt: c.resetAt, resumeAt: global ? null : ul.resumeAtFor(c.resetAt) };
    this.log(run, "usage_limit", id, `${c.rule}${c.resetAt ? `, resets ${new Date(c.resetAt).toISOString()}` : ""}: ${c.evidence}`);
    await this.doSuspend(run, { reason: `paused: quota (${c.rule})`, by: "factory", usageLimit: hold });
    const event = { runId: run.id, agentId: st.agentId, provider: failure.provider ?? null, rule: c.rule, evidence: c.evidence, resetAt: c.resetAt };
    setImmediate(() => {
      try {
        ul.matched(event);
      } catch (error) {
        console.error("blueprints: usage-limit match failed", error);
      }
    });
  }

  private usageHold(): { reason: string; resumeAt: number | null } | null {
    return this.usageLimits?.enabled() ? this.usageLimits.globalHold() : null;
  }

  /** The stage's worker ended a turn. A verdict already given makes this a no-op. */
  turnEnded(agentId: string, outcome: { kind: "completed" | "failed" | "canceled"; message?: string; code?: string; provider?: string | null }): Promise<void> {
    if (this.store.all().some((r) => r.retiring?.includes(agentId))) return this.flushRetired(agentId);
    const run = this.store.active().find((r) => r.stage && r.stages[r.stage]?.agentId === agentId && r.stages[r.stage].status === "running");
    if (!run) return Promise.resolve();
    return this.exclusive(run.id, async () => {
      const id = run.stage;
      if (!id || run.stages[id]?.agentId !== agentId || run.stages[id].status !== "running" || run.status !== "running") return;
      const st = run.stages[id];
      if (outcome.kind === "canceled") return; // someone interrupted it on purpose
      const now = this.ports.now();
      st.lastNudgeAt = now;
      if (outcome.kind === "completed" && st.workerWaitSince) {
        // A worker that declared a wait (blueprint_waiting) ends its turn on purpose and is woken by its events: no nudge, no
        // attempt. Past the ceiling, a person is asked, as on the tick (decision f1cd49be).
        if (now - st.workerWaitSince < WORKER_WAIT_CEILING_MS) {
          this.log(run, "worker_waiting_turn_end", id, run.waitingFor ?? "an outside system");
          this.store.save();
          return;
        }
        const why = `waited ${Math.round((now - st.workerWaitSince) / 60_000)} min on: ${run.waitingFor ?? "an outside system"}`;
        st.workerWaitSince = null;
        this.log(run, "worker_wait_ceiling", id, why);
        return this.pause(run, id, why);
      }
      this.log(run, "turn_ended", id, outcome.kind === "failed" ? `failed: ${outcome.message ?? ""}` : "no verdict");
      if (outcome.kind === "failed") return this.agentFailed(run, id, outcome.message ?? "turn failed", { message: outcome.message ?? "", code: outcome.code ?? null, provider: outcome.provider ?? null });
      return this.nudge(run, id);
    }).catch((e) => this.crash(run, e));
  }

  /** A worker's verdict. The caller must be the stage's current worker. */
  /**
   * A worker says its stage is waiting on a person or an outside system (a review, a merge queue) and that it watches for it:
   * the run shows `waitingFor` and is not "stalled" while it waits. Cleared by the next verdict or transition. Human decision c11d3b3e.
   */
  workerWaiting(callerId: string, reason: string): { stage: string } {
    const run = this.store.active().find((r) => r.stage && r.stages[r.stage]?.agentId === callerId && r.stages[r.stage].status === "running");
    if (!run) throw new UsageError("You are not the worker of a running stage.");
    const text = clip(reason.trim() || "waiting", 300);
    const st = run.stages[run.stage!];
    st.workerWaitSince ??= this.ports.now();
    if (run.waitingFor !== text) {
      run.waitingFor = text;
      this.log(run, "worker_waiting", run.stage, text);
    }
    this.store.save();
    return { stage: run.stage! };
  }

  /**
   * A worker saves the result of one step of its stage (for a QA, one criterion) in the run store. A replacement worker of the
   * same entry (after a pod eviction, an OOMKill, a lost session) gets the saved results in its prompt and only does what is
   * missing (decision a6decaa8). A record with the same key replaces the earlier one.
   */
  workerProgress(callerId: string, input: { key: string; status: string; note?: string }): { stage: string; saved: number } {
    const run = this.store.active().find((r) => r.stage && r.stages[r.stage]?.agentId === callerId && (r.stages[r.stage].status === "running" || r.stages[r.stage].status === "entering"));
    if (!run) throw new UsageError("You are not the worker of a running stage.");
    const st = run.stages[run.stage!];
    const key = clip(input.key.trim(), 100);
    if (!key) throw new UsageError("key is empty.");
    const list = (st.progress ??= []);
    const entry = { key, status: clip(input.status.trim() || "done", 40), note: clip((input.note ?? "").trim(), 1000), at: this.ports.now() };
    const i = list.findIndex((p) => p.key === key);
    if (i >= 0) list[i] = entry;
    else if (list.length >= MAX_PROGRESS) throw new UsageError(`A stage entry keeps at most ${MAX_PROGRESS} progress records; reuse a key.`);
    else list.push(entry);
    this.log(run, "progress", run.stage, `${key}: ${entry.status}`);
    this.store.save();
    return { stage: run.stage!, saved: list.length };
  }

  async verdict(callerId: string, input: { run?: string; stage?: string; verdict: string; summary?: string; data?: Record<string, unknown> }): Promise<{ next: string }> {
    const held = this.store.all().find((r) => r.status === "suspended" && (!input.run || r.id === input.run) && r.stage && r.stages[r.stage]?.agentId === callerId);
    if (held) throw new UsageError(`Run ${held.id} is suspended${held.suspended ? ` (${held.suspended.reason})` : ""}: your verdict is not taken until it is resumed. Stop now; you are woken on resume.`);
    const candidates = this.store.active().filter((r) => (!input.run || r.id === input.run) && r.stage && (!input.stage || r.stage === input.stage) && r.stages[r.stage]?.agentId === callerId);
    if (candidates.length === 0) throw new UsageError("You are not the worker of a running stage" + (input.run ? ` of run ${input.run}` : "") + ".");
    const run = candidates[0];
    return this.exclusive(run.id, async () => {
      const id = run.stage!;
      const st = run.stages[id];
      const def = this.stageDef(run, id);
      if (st.agentId !== callerId) throw new UsageError(`Stage ${id} is not waiting for a verdict (it is ${st.status}).`);
      if (st.status !== "running") {
        // A stage that was paused or exhausted while its (latest) worker is still alive: that worker finished after all.
        if (st.status !== "entering" && st.status !== "exhausted") throw new UsageError(`Stage ${id} is not waiting for a verdict (it is ${st.status}).`);
      }
      const late = st.status !== "running";
      const allowed = stageVerdicts(def);
      if (!allowed.includes(input.verdict)) throw new UsageError(`Verdict "${input.verdict}" is not one of [${allowed.join(", ")}].`);
      const data = input.data ?? {};
      await this.verifyFacts(run, def as AgentStage, input.verdict, data);
      if (late) {
        this.log(run, "late_verdict", id, `accepted from ${callerId}, the latest worker of a stage that was ${st.status}`);
        this.withdrawEscalations(run, "the stage's worker gave its verdict");
        run.pm.pending = null;
        run.status = "running";
        run.error = null;
        run.waitingFor = null;
      }
      st.verdict = input.verdict;
      st.summary = input.summary ? clip(input.summary, 4000) : null;
      st.data = data;
      st.workerWaitSince = null;
      st.status = "done";
      st.endedAt = this.ports.now();
      if (st.wardenTask) {
        this.ports.wardenDone(st.wardenTask, `verdict ${input.verdict}`);
        st.wardenTask = null;
      }
      this.log(run, "verdict", id, `${input.verdict}${st.summary ? `: ${clip(st.summary, 200)}` : ""}`);
      const next = def.on[input.verdict];
      this.store.save();
      void this.exclusive(run.id, () => this.go(run, id, next, `verdict ${input.verdict}`)).catch((e) => this.crash(run, e));
      return { next };
    });
  }

  /** Stage facts come from GitHub: PR URLs must exist, and a verdict that claims a PR state must match it. */
  private async verifyFacts(run: Run, def: AgentStage, verdict: string, data: Record<string, unknown>): Promise<void> {
    const urls = Array.isArray(data.pr_urls) ? (data.pr_urls as unknown[]).filter((u): u is string => typeof u === "string") : [];
    for (const url of urls) {
      const known = this.ports.isPrUrl ? this.ports.isPrUrl(url) : /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url);
      if (!known) throw new UsageError(`data.pr_urls: "${url}" is not a GitHub pull request URL.`);
    }
    const checks = def.verify?.[verdict] ?? [];
    const toCheck = checks.length || urls.length ? (urls.length ? urls : this.prUrls(run, def.pr_urls_from)) : [];
    for (const url of toCheck) {
      let f: PrFacts;
      try {
        f = await this.freshFacts(url);
      } catch (error) {
        throw new UsageError(`Cannot verify ${url} on GitHub (${(error as Error).message}); try again.`);
      }
      if (!f.exists) throw new UsageError(`GitHub has no pull request ${url}.`);
      // "open" guards against a PR closed without merging; a merged one is the goal, not an error (bp-a4ee2a1b could not report done).
      if (checks.includes("open") && f.state === "closed") throw new UsageError(`GitHub says ${url} is closed without merging, not open.`);
      if (checks.includes("ci_green") && f.ci !== "green") throw new UsageError(`GitHub says CI on ${url} (head ${f.head.slice(0, 12)}) is ${f.ci}, not green. Fix it before reporting "${verdict}".`);
      if (checks.includes("mergeable") && f.mergeable !== true) throw new UsageError(`GitHub says ${url} is not mergeable (${f.mergeable === null ? "unknown" : "conflicts"}).`);
    }
  }

  // ---- gates (Inbox) ----

  private async openGate(run: Run, id: string, def: GateStage): Promise<void> {
    const st = run.stages[id];
    let criteriaSha: string | null = null;
    if (def.criteria) {
      criteriaSha = createHash("sha256").update(this.r(run, def.criteria).trim()).digest("hex");
      const key = approvalKey(run, id, criteriaSha);
      const prior = this.store.approval(key);
      if (prior && def.on[prior.optionId]) {
        st.gate = { itemId: "", heads: {}, criteriaSha, reused: true };
        st.verdict = prior.optionId;
        st.summary = `identical approval reused (criteria ${criteriaSha.slice(0, 12)}, by ${prior.by})`;
        st.status = "done";
        this.log(run, "approval_reused", id, criteriaSha.slice(0, 12));
        return this.go(run, id, def.on[prior.optionId], `approval reused`);
      }
    }
    const heads: Record<string, string> = {};
    let facts = "";
    if (def.pr) {
      try {
        for (const url of this.r(run, def.pr).split(",").map((s) => s.trim()).filter(Boolean)) {
          const f = await this.freshFacts(url);
          heads[url] = f.head;
          facts += `\n- ${url} @ ${f.head.slice(0, 12)}: ${f.state}, CI ${f.ci}`;
        }
      } catch (error) {
        if (!isTransientError(error)) throw error;
        return this.factsUnavailable(run, id, error, "reopen");
      }
      this.factsRecovered(run, id);
    }
    if (def.wait === "merge") return this.openMergeWait(run, id, def, heads);
    const options = def.options ?? (def.free_text ? [] : APPROVAL);
    const context = [def.context ? this.r(run, def.context) : "", facts ? `PRs this gate is tied to:${facts}` : "", criteriaSha ? `Criteria sha: ${criteriaSha.slice(0, 12)}` : ""].filter(Boolean).join("\n\n");
    const { itemId } = this.ports.ask({
      runId: run.id,
      title: this.askerTitle(run),
      question: this.r(run, def.question),
      context,
      options,
      freeText: def.free_text || options.length === 0,
      dedupeKey: `${run.id}:${id}:${st.runs}`,
      expiresInMinutes: def.expires_in_minutes,
      kind: !def.free_text && !def.options ? "approval" : "question",
    });
    st.gate = { itemId, heads, criteriaSha, reused: false, openedAt: this.ports.now() };
    st.status = "waiting";
    run.status = "waiting";
    run.waitingFor = `gate ${id} (inbox ${itemId})`;
    this.log(run, "gate_opened", id, itemId);
    this.store.save();
    this.notify(run, { kind: "waiting", stage: id, reason: `gate: ${clip(this.r(run, def.question), 300)} (inbox ${itemId})`, key: `${run.id}:gate:${itemId}` });
    if (def.pm && this.pmMode()) {
      const choices = options.length ? ` Options: ${options.map((o) => `${o.id} (${o.label})`).join(", ")}.` : " It takes a free-text answer.";
      await this.judge(run, "gate", id, `Gate "${id}" waits for an answer (inbox item ${itemId}): ${clip(this.r(run, def.question), 1000)}.${choices}${context ? `\nContext: ${clip(context, 2000)}` : ""}`, { gateItemId: itemId });
    }
  }

  /** `wait = "merge"`: nothing is asked; `tick` completes the gate when the PRs are merged, or on its timeout. */
  private openMergeWait(run: Run, id: string, def: GateStage, heads: Record<string, string>): void {
    const st = run.stages[id];
    const why = def.context ? this.r(run, def.context) : "";
    st.gate = { itemId: "", heads, criteriaSha: null, reused: false, openedAt: this.ports.now(), passive: true };
    st.status = "waiting";
    run.status = "waiting";
    run.waitingFor = `merge of ${Object.keys(heads).join(", ")}`;
    this.log(run, "gate_opened", id, "waiting for the merge");
    this.store.save();
    this.notify(run, { kind: "waiting", stage: id, reason: `waiting for the merge of ${Object.keys(heads).join(", ")}${why ? `: ${clip(why, 200)}` : ""}`, key: `${run.id}:merge-wait:${id}:${st.runs}` });
  }

  /** The Inbox item of a gate changed state. */
  gateResolved(itemId: string): Promise<void> {
    const escalated = this.store.all().find((r) => r.escalations?.[itemId]);
    if (escalated) return this.exclusive(escalated.id, () => this.handleEscalation(escalated, itemId)).catch((e) => this.crash(escalated, e));
    const run = this.store.active().find((r) => Object.values(r.stages).some((s) => s.gate?.itemId === itemId && s.status === "waiting"));
    if (!run) return Promise.resolve();
    return this.exclusive(run.id, () => this.handleGate(run, itemId)).catch((e) => this.crash(run, e));
  }

  /** A person answered the Inbox item of a stuck or paused run: do what they chose. */
  private async handleEscalation(run: Run, itemId: string): Promise<void> {
    const gate = this.ports.gate(itemId);
    const info = run.escalations?.[itemId];
    if (!gate || !info || gate.status !== "answered") return;
    delete run.escalations![itemId];
    this.log(run, "escalation_answered", info.stage, `${gate.optionId ?? "other"} by ${gate.by ?? "?"}`);
    if (run.status === "done" || run.status === "aborted") return;
    switch (gate.optionId) {
      case "abort":
        return this.finish(run, "aborted", "aborted from the Inbox");
      case "leave":
        return this.store.save();
      case "resume":
      case "resume1":
      case "resume3":
        return this.resumeFromInbox(run, info.stage, { stage: info.stage, extraAttempts: gate.optionId === "resume3" ? 3 : gate.optionId === "resume1" ? 1 : 0 });
      default:
        // "Other…": the text goes to the worker as a note and the stage gets one more try.
        return this.resumeFromInbox(run, info.stage, { stage: info.stage, extraAttempts: 1, note: gate.text ? `Instruction from the human: ${gate.text}` : undefined });
    }
  }

  /** A resume chosen in the Inbox that GitHub could not serve leaves the run as it was and says so; it never fails the run. */
  private async resumeFromInbox(run: Run, stage: string, input: { stage: string; extraAttempts: number; note?: string }): Promise<void> {
    try {
      await this.doResume(run, input);
    } catch (error) {
      if (!(error instanceof RetryLaterError)) throw error;
      this.log(run, "resume_refused", stage, error.message);
      this.store.save();
      this.notify(run, { kind: "waiting", stage, reason: `${error.message} Resume it from the Blueprints tab or with blueprint_resume.`, key: `${run.id}:resume-refused:${stage}:${run.history.length}` });
    }
  }

  private async handleGate(run: Run, itemId: string): Promise<void> {
    {
      const id = Object.keys(run.stages).find((k) => run.stages[k].gate?.itemId === itemId && run.stages[k].status === "waiting");
      if (!id) return;
      const st = run.stages[id];
      const def = this.stageDef(run, id) as GateStage;
      const gate = this.ports.gate(itemId);
      if (!gate || gate.status === "pending") return;
      if (gate.status === "withdrawn" || gate.status === "archived") return; // withdrawn by us, or the asker went away
      if (gate.status === "expired") {
        st.status = "done";
        st.endedAt = this.ports.now();
        run.status = "running";
        run.waitingFor = null;
        if (def.default_answer) {
          const next = def.on[def.default_answer] ?? def.on.default!;
          st.verdict = def.default_answer;
          st.summary = `nobody answered in ${def.expires_in_minutes} min: default answer ${def.default_answer}`;
          this.log(run, "gate_answered", id, `${def.default_answer} by default (expired after ${def.expires_in_minutes} min)`);
          return this.go(run, id, next, `default answer ${def.default_answer}`);
        }
        st.verdict = "expired";
        return this.go(run, id, def.on.expired ?? def.on.exhausted ?? "failed", "gate expired");
      }
      const answer = gate.optionId ?? "answered";
      // The PR facts the answer is checked against, read before anything changes: on a GitHub outage the answer stays pending
      // in the run and the tick applies it once GitHub answers.
      let read: Record<string, PrFacts> | null = null;
      if (def.pr && Object.keys(st.gate!.heads).length) {
        read = {};
        try {
          for (const url of Object.keys(st.gate!.heads)) read[url] = await this.freshFacts(url);
        } catch (error) {
          if (!isTransientError(error)) throw error;
          return this.factsUnavailable(run, id, error, "answer");
        }
        this.factsRecovered(run, id);
      }
      if (def.store_as && gate.text) {
        const spec = run.def.vars[def.store_as];
        if (spec?.pattern && !new RegExp(spec.pattern).test(gate.text.trim())) {
          this.log(run, "answer_invalid", id, `does not match ${spec.pattern}`);
          st.gate = null;
          st.status = "entering";
          run.status = "running";
          return this.openGate(run, id, def); // ask again: dedupe key differs through runs
        }
        run.vars[def.store_as] = gate.text.trim();
        run.vars[`${def.store_as}_confirmed`] = "true"; // a person typed it
      }
      if (def.note_to && gate.text) (run.stages[def.note_to] ??= freshStage()).notes.push(`Answer from the human to "${clip(this.r(run, def.question), 200)}": ${gate.text}`);
      if (answer === "hold" && def.hold_minutes) {
        st.status = "waiting";
        st.reopenAt = this.ports.now() + def.hold_minutes * 60_000;
        st.gate = null;
        run.waitingFor = `gate ${id} on hold for ${def.hold_minutes} min`;
        this.log(run, "gate_hold", id, `${def.hold_minutes} min`);
        this.store.save();
        return;
      }
      if (read) {
        const verdict = await this.prGateCheck(run, id, def, answer, read);
        if (verdict === "refused") return;
      }
      st.verdict = answer;
      st.summary = gate.text ?? null;
      st.status = "done";
      st.endedAt = this.ports.now();
      run.status = "running";
      run.waitingFor = null;
      if (st.gate?.criteriaSha && /approv|yes|ok/i.test(answer)) {
        this.store.approve(approvalKey(run, id, st.gate.criteriaSha), answer, gate.by ?? "human", this.ports.now());
      }
      this.log(run, "gate_answered", id, `${answer} by ${gate.by ?? "?"}`);
      const next = def.on[answer] ?? def.on.default;
      if (!next) return this.finish(run, "failed", `gate ${id}: no edge for answer "${answer}"`);
      return this.go(run, id, next, `answer ${answer}`);
    }
  }

  /** "merged" must be true on GitHub. Anything else on a PR gate is checked for a head that moved meanwhile. */
  private async prGateCheck(run: Run, id: string, def: GateStage, answer: string, read: Record<string, PrFacts>): Promise<"ok" | "refused"> {
    const st = run.stages[id];
    const heads = st.gate!.heads;
    for (const [url, head] of Object.entries(heads)) {
      const f = read[url];
      if (answer === "merged" && f.state === "open" && f.queued) {
        // In the merge queue: wait for the merge on GitHub instead of asking "merged?" again (human decision d82771ac).
        this.log(run, "merge_queued", id, `${url} is in the merge queue: waiting for the merge, no new question`);
        st.gate = { ...st.gate!, itemId: "", passive: true, queued: true, openedAt: this.ports.now() };
        st.status = "waiting";
        run.status = "waiting";
        run.waitingFor = `merge queue (${url})`;
        this.store.save();
        return "refused";
      }
      if (answer === "merged" && f.state !== "merged") {
        this.log(run, "merge_not_seen", id, `${url} is ${f.state} on GitHub`);
        st.status = "entering";
        st.gate = null;
        run.status = "running";
        await this.openGate(run, id, def);
        return "refused";
      }
      if (answer !== "merged" && f.head !== head && f.state === "open") {
        st.status = "entering";
        st.gate = null;
        run.status = "running";
        await this.go(run, id, def.on.head_moved ?? id, `head of ${url} moved while the answer was pending`);
        return "refused";
      }
    }
    return "ok";
  }

  // ---- calls, child runs, extension kinds ----

  /** A lone `{{stage.x.data.k}}` keeps the type of the stored value (a list stays a list). */
  private rawData(run: Run, template: string): unknown {
    const m = /^\{\{\s*stage\.([a-z][a-z0-9_-]*)\.data\.([^}\s]+)\s*\}\}$/.exec(template);
    return m ? run.stages[m[1]]?.data[m[2]] : undefined;
  }

  private deepRender(run: Run, value: unknown): unknown {
    if (typeof value === "string") {
      const raw = this.rawData(run, value);
      return raw !== undefined && typeof raw !== "string" ? raw : this.r(run, value);
    }
    if (Array.isArray(value)) {
      return value.flatMap((v) => {
        const out = this.deepRender(run, v);
        if (typeof v === "string" && /^\{\{[^}]*\}\}$/.test(v.trim()) && out === "") return [];
        return typeof v === "string" && Array.isArray(out) ? out : [out];
      });
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.deepRender(run, v)]));
    return value;
  }

  private async doCall(run: Run, id: string, def: CallStage): Promise<void> {
    const st = run.stages[id];
    const args = this.deepRender(run, def.args) as Record<string, unknown>;
    const direct = this.ports.tool(def.tool);
    st.status = "running";
    this.store.save();
    if (direct) {
      let verdict = "ok";
      let summary: string;
      try {
        const out = await direct(args);
        summary = clip(typeof out === "string" ? out : JSON.stringify(out), 2000);
      } catch (error) {
        verdict = "error";
        summary = (error as Error).message;
      }
      st.verdict = verdict;
      st.summary = summary;
      st.status = "done";
      st.endedAt = this.ports.now();
      this.log(run, "call", id, `${def.tool} -> ${verdict}`);
      return this.go(run, id, def.on[verdict] ?? (verdict === "ok" ? "done" : "failed"), `call ${verdict}`);
    }
    // Not a tool of the Factory: a short-lived worker with the right MCP servers makes the call.
    if (!def.role) {
      st.verdict = "error";
      st.summary = `tool ${def.tool} is not a Factory tool; give the stage a role whose agents can call it`;
      st.status = "done";
      return this.go(run, id, def.on.error ?? "failed", "no way to call the tool");
    }
    const agentStage: AgentStage = {
      id,
      kind: "agent",
      role: def.role,
      agent: "new",
      workspace: "new",
      prompt: `Call the MCP tool \`${def.tool}\` exactly once with these arguments, and nothing else:\n${JSON.stringify(args, null, 2)}\nThen call blueprint_verdict with verdict "ok" (summary: the tool's answer) or "error" (summary: the error).`,
      verdicts: ["ok", "error"],
      max_attempts: 2,
      max_runs: 5,
      flake_retries: 0,
      on: def.on,
    };
    // Run it as an agent stage by temporarily swapping the definition's behaviour.
    run.def.stage = run.def.stage.map((s) => (s.id === id ? { ...agentStage, on: { ok: def.on.ok ?? "done", error: def.on.error ?? "failed", ...def.on } } : s)) as Stage[];
    st.runs -= 1;
    return this.enter(run, id);
  }

  private async startChild(run: Run, id: string, def: BlueprintStage): Promise<void> {
    const st = run.stages[id];
    // A resumed or re-entered stage re-attaches to its live child instead of starting a second one:
    // the idempotency key counts entries, so a new entry alone would not join it. An ended child is not
    // re-attached: its outcome already reached the parent when it ended, and re-entering after it means a new run.
    const live = this.store.all().find((r) => r.parent?.runId === run.id && r.parent.stageId === id && r.status !== "done" && r.status !== "failed" && r.status !== "aborted");
    if (live) {
      st.childRunId = live.id;
      st.status = "waiting";
      run.waitingFor = `child run ${live.id}`;
      this.log(run, "child_reattached", id, live.id);
      this.store.save();
      return;
    }
    const vars = Object.fromEntries(Object.entries(def.vars).map(([k, v]) => [k, this.r(run, v)]));
    const confirmed = Object.fromEntries(Object.entries(run.vars).filter(([k]) => k.endsWith("_confirmed")));
    let child: Run;
    try {
      child = this.start({ blueprint: def.blueprint, vars: { ...confirmed, ...vars }, at: def.at, requestedBy: `run ${run.id}`, ownerAgentId: run.pmAgentId, idempotencyKey: `${run.id}:${id}:${st.runs}`, parent: { runId: run.id, stageId: id } });
    } catch (error) {
      st.verdict = "failed";
      st.summary = (error as Error).message;
      st.status = "done";
      return this.go(run, id, def.on.failed ?? "failed", `child could not start: ${st.summary}`);
    }
    st.childRunId = child.id;
    st.status = "waiting";
    run.waitingFor = `child run ${child.id}`;
    this.log(run, "child_started", id, child.id);
    this.store.save();
  }

  /** An extension stage may take long (a wait): it runs outside the run's lock, which only its completion takes. */
  private async runExtension(run: Run, id: string, def: Stage): Promise<void> {
    const st = run.stages[id];
    const handler = this.ports.stageKind(def.kind ?? "");
    if (!handler) {
      // After a restart of the Factory (or of the plugin that provides the kind), the extension registers again a little later:
      // wait for it instead of failing the run (bp-6a9e18ab failed at wait-pins on "train" during an update).
      const now = this.ports.now();
      st.kindWaitSince ??= now;
      if (now - st.kindWaitSince < KIND_WAIT_MS) {
        if (st.status !== "entering" || run.waitingFor?.startsWith("extension") !== true) this.log(run, "kind_waiting", id, def.kind ?? "");
        st.status = "entering";
        run.status = "running";
        run.waitingFor = `extension for stage kind "${def.kind}" (not registered yet)`;
        this.store.save();
        return;
      }
      st.kindWaitSince = null;
      this.log(run, "no_such_kind", id, def.kind ?? "");
      return this.finish(run, "failed", `stage ${id}: no extension provides the stage kind "${def.kind}" (waited ${Math.round(KIND_WAIT_MS / 60_000)} min)`);
    }
    if (st.kindWaitSince) {
      st.kindWaitSince = null;
      if (run.waitingFor?.startsWith("extension for stage kind")) run.waitingFor = null;
    }
    st.status = "running";
    this.store.save();
    const { id: _id, kind: _k, on: _o, skip_if: _s, skip_if_merged: _m, title: _t, ...params } = def as Record<string, unknown> & Stage;
    const entry = st.runs;
    void handler({ runId: run.id, stageId: id, blueprint: run.blueprint, params: this.deepRender(run, params) as Record<string, unknown>, vars: { ...run.vars } })
      .catch((error): StageOutcome => ({ verdict: "error", summary: (error as Error).message }))
      .then((outcome) =>
        this.exclusive(run.id, async () => {
          if (run.stage !== id || st.status !== "running" || st.runs !== entry || run.status !== "running") return; // aborted, moved or re-entered meanwhile
          st.verdict = outcome.verdict;
          st.summary = outcome.summary ?? null;
          st.data = outcome.data ?? {};
          st.status = "done";
          st.endedAt = this.ports.now();
          this.log(run, "extension", id, outcome.verdict);
          const next = def.on[outcome.verdict] ?? def.on.default;
          if (!next) return this.finish(run, "failed", `stage ${id}: no edge for verdict "${outcome.verdict}"`);
          return this.go(run, id, next, `verdict ${outcome.verdict}`);
        }),
      )
      .catch((e) => this.crash(run, e));
  }

  // ---- background ----

  /** Replays what a restart interrupted. */
  async resumeAll(): Promise<void> {
    await this.flushRetired().catch((e) => console.error("blueprints: archiving retired workers failed", e));
    for (const run of this.store.active()) {
      await this.exclusive(run.id, async () => {
        const id = run.stage;
        if (!id) return;
        const st = run.stages[id];
        if (!st) return;
        await this.replay(run, id, st, {});
      }).catch((e) => this.crash(run, e));
    }
  }

  /** Redo the effect of the stage's state: after a restart, or when a suspended run is resumed (then no attempt is used). */
  private async replay(run: Run, id: string, st: StageState, opts: { resumed?: boolean }): Promise<void> {
    // A judgement was asked of a PM that is gone (or never existed): find one, or go to the human.
    if (run.pm.pending && !(await this.hasLivePm(run)) && !pmCalls(run)[pmKey(run.id, "exhausted", run.pm.pending.stage, run.stages[run.pm.pending.stage]?.runs ?? 0)]) {
      await this.notifyPm(run, this.pmText(run, run.pm.pending.stage, run.pm.pending.reason));
      return;
    }
    if (st.status === "entering") {
      const def = this.stageDef(run, id);
      if ((def.kind ?? "agent") === "agent" && st.runs > 0) await this.dispatch(run, id, "retry", { free: true });
      else await this.enter(run, id);
    } else if (st.status === "waiting" && st.gate?.itemId) {
      const gate = this.ports.gate(st.gate.itemId);
      if (gate && gate.status !== "pending") await this.handleGate(run, st.gate.itemId);
    } else if (st.status === "waiting" && st.childRunId) {
      const child = this.store.get(st.childRunId);
      if (child && (child.status === "done" || child.status === "failed" || child.status === "aborted")) await this.childFinished(run, child);
    } else if (st.status === "running" && (this.stageDef(run, id).kind ?? "agent") === "agent") {
      const state = st.agentId ? await this.ports.agentState(st.agentId) : "gone";
      if (opts.resumed) {
        if (state === "gone") await this.dispatch(run, id, "retry", { free: true, fresh: true });
        else if (state === "idle") await this.dispatch(run, id, "wake", { free: true });
        // a worker still in its turn (a local one, or a busy pod that was not suspended) carries on by itself
      } else if (state === "gone") await this.agentFailed(run, id, "worker gone after restart");
      else if (state === "idle") await this.dispatch(run, id, "nudge");
    } else if (st.status === "running") {
      await this.enter(run, id); // an extension stage or call: run again (idempotent by contract)
    }
  }

  /** Poll: PR gates (head moved, merged), idle workers whose turn_ended we missed. */
  async tick(): Promise<void> {
    const now = this.ports.now();
    this.observer.tick?.();
    await this.dequeue().catch((e) => console.error("blueprints: dequeue failed", e));
    await this.pmTick(now).catch((e) => console.error("blueprints: PM tick failed", e));
    for (const run of this.store.active()) {
      const id = run.stage;
      if (!id) continue;
      const st = run.stages[id];
      if (!st) continue;
      try {
        if (st.status === "entering" && st.kindWaitSince && run.status === "running") {
          await this.exclusive(run.id, async () => {
            if (run.stage !== id || st.status !== "entering" || !st.kindWaitSince) return;
            await this.runExtension(run, id, this.stageDef(run, id));
          });
        } else if (st.status === "entering" && st.quotaRetry && now >= st.quotaRetry.at && run.status === "running") {
          await this.exclusive(run.id, async () => {
            const q = st.quotaRetry;
            if (run.stage !== id || st.status !== "entering" || !q || now < q.at) return;
            this.log(run, "quota_retry", id, `retry ${q.n}`);
            await this.dispatch(run, id, q.why, q.opts);
          });
        } else if (st.status === "waiting" && !st.gate && st.reopenAt && now >= st.reopenAt) {
          await this.exclusive(run.id, async () => {
            if (run.stage !== id || st.status !== "waiting" || st.gate || !st.reopenAt) return;
            st.reopenAt = null;
            st.status = "entering";
            run.status = "running";
            run.waitingFor = null;
            await this.openGate(run, id, this.stageDef(run, id) as GateStage);
          });
        } else if (st.status === "waiting" && st.gate?.itemId && st.factsRetry?.answer) {
          // An answer GitHub was down for: apply it once the back-off is over.
          if (now < st.factsRetry.at) continue;
          await this.exclusive(run.id, async () => {
            if (run.stage !== id || st.status !== "waiting" || !st.gate?.itemId) return;
            await this.handleGate(run, st.gate.itemId);
          });
        } else if (st.status === "waiting" && st.gate && (st.gate.itemId || st.gate.passive) && Object.keys(st.gate.heads).length) {
          // GitHub was down on the last poll: wait out the back-off, the stage keeps waiting.
          if (st.factsRetry && now < st.factsRetry.at) continue;
          try {
            await this.pollPrGate(run, id);
          } catch (error) {
            if (!isTransientError(error)) throw error;
            await this.exclusive(run.id, async () => {
              if (run.stage === id && st.status === "waiting" && st.gate) this.factsUnavailable(run, id, error, "poll");
            });
            continue;
          }
          if (st.factsRetry && !st.factsRetry.answer) this.factsRecovered(run, id);
          if (st.gate?.passive) await this.expireMergeWait(run, id);
        } else if (st.status === "waiting" && st.gate?.itemId) this.remindGate(run, id);
        else if (st.status === "running" && run.status === "running" && (this.stageDef(run, id).kind ?? "agent") === "agent" && st.agentId) {
          // A worker that said it waits on a person or an outside system (a review) watches it with events: no nudges, no attempts,
          // until the ceiling; then a person is asked (decision f1cd49be: babysit was nudged every minute while a review bot had not answered).
          if (st.workerWaitSince) {
            if (now - st.workerWaitSince < WORKER_WAIT_CEILING_MS) continue;
            await this.exclusive(run.id, async () => {
              if (run.stage !== id || st.status !== "running" || !st.workerWaitSince) return;
              const mins = Math.round((now - st.workerWaitSince) / 60_000);
              const why = `waited ${mins} min on: ${run.waitingFor ?? "an outside system"}`;
              st.workerWaitSince = null;
              this.log(run, "worker_wait_ceiling", id, why);
              await this.pause(run, id, why);
            });
            continue;
          }
          const grace = this.ports.settings().idleGraceSeconds * 1000;
          if (now - (st.lastNudgeAt ?? st.startedAt ?? now) < grace) continue;
          const state = await this.ports.agentState(st.agentId);
          if (state === "running") continue;
          await this.exclusive(run.id, async () => {
            if (run.stage !== id || st.status !== "running" || st.lastNudgeAt !== null && now - st.lastNudgeAt < grace) return;
            st.lastNudgeAt = now;
            this.log(run, "stalled", id, state);
            if (state === "gone") await this.agentFailed(run, id, "worker gone");
            else await this.nudge(run, id);
          });
        }
      } catch (error) {
        console.error(`blueprints: tick of ${run.id} failed`, error);
      }
    }
    this.store.prune(now);
  }

  private async pollPrGate(run: Run, id: string): Promise<void> {
    const st = run.stages[id];
    const def = this.stageDef(run, id) as GateStage;
    const heads = st.gate!.heads;
    let merged = 0;
    let queuedNow = false;
    const places: string[] = [];
    const unplaced: string[] = [];
    for (const [url, head] of Object.entries(heads)) {
      // A queued PR is read fresh: LEFT_QUEUE_POLLS counts distinct reads, not one cached answer seen twice.
      const f = await this.ports.prFacts(url, st.gate?.queued || st.gate?.inQueue?.[url] ? { maxAgeMs: 0 } : undefined);
      if (f.state === "open" && f.queued) queuedNow = true;
      if (f.state === "open" && f.queuePosition !== undefined) {
        places.push(`${url} #${f.queuePosition}${f.queueEtaSeconds !== undefined ? `, ETA ~${Math.max(1, Math.round(f.queueEtaSeconds / 60))} min` : ""}`);
      } else if (f.state !== "merged") unplaced.push(st.gate?.leftNoticed?.[url] === f.head && !f.queued ? `${url} (out of the merge queue)` : url);
      if (st.gate?.passive && !st.gate.queued && f.state === "open" && f.head === head) this.watchLeftQueue(run, id, url, f);
      if (f.state === "merged") merged += 1;
      else if (st.gate?.queued && f.state === "open" && f.queued !== false) st.gate.notQueuedPolls = 0;
      else if (st.gate?.queued && f.state === "open" && (st.gate.notQueuedPolls = (st.gate.notQueuedPolls ?? 0) + 1) < LEFT_QUEUE_POLLS) {
        // One poll that does not see the PR in the queue is not "left the queue": GitHub's answer flips while it moves the PR.
        this.store.save();
        return;
      } else if (st.gate?.queued && (f.state !== "open" || f.queued === false)) {
        // left the merge queue without merging: ask the person again
        await this.exclusive(run.id, async () => {
          if (run.stage !== id || st.status !== "waiting" || !st.gate?.queued) return;
          this.log(run, "merge_not_seen", id, `${url} left the merge queue (${f.state})`);
          st.gate = null;
          st.status = "entering";
          run.status = "running";
          await this.openGate(run, id, def);
        });
        return;
      } else if (f.state === "open" && f.head !== head) {
        await this.exclusive(run.id, async () => {
          if (run.stage !== id || st.status !== "waiting" || !st.gate) return;
          if (st.gate.itemId) this.ports.withdraw(st.gate.itemId, `head of ${url} moved to ${f.head.slice(0, 12)}`);
          st.status = "done";
          st.verdict = "head_moved";
          st.gate = null;
          run.status = "running";
          this.log(run, "head_moved", id, `${url} ${head.slice(0, 12)} -> ${f.head.slice(0, 12)}`);
          await this.go(run, id, def.on.head_moved ?? id, "head moved");
        });
        return;
      }
    }
    // The run's status says where the unmerged PRs stand, never naming one already merged (OPS-378: it kept a merged PR's place).
    if (st.gate && places.length + unplaced.length) {
      const rest = unplaced.length ? `merge of ${unplaced.join(", ")}` : "";
      const where = places.length ? `merge queue: ${places.join("; ")}${rest ? `; ${rest}` : ""}` : rest;
      if (run.waitingFor !== where) {
        run.waitingFor = where;
        this.store.save();
      }
    }
    // Queued but still not merged after `stall_minutes` (15 by default): say so once, keep waiting; never a new question.
    if ((st.gate?.queued || (st.gate?.passive && queuedNow)) && st.gate && !st.gate.slowNoticed && merged < Object.keys(heads).length && this.ports.now() - (st.gate.openedAt ?? this.ports.now()) >= (def.stall_minutes ?? 15) * 60_000) {
      st.gate.slowNoticed = true;
      const mins = Math.round((this.ports.now() - (st.gate.openedAt ?? this.ports.now())) / 60_000);
      this.log(run, "merge_queue_slow", id, `still in the merge queue after ${mins} min`);
      this.notify(run, { kind: "waiting", stage: id, reason: `still in the merge queue after ${mins} min: ${places.length ? places.join("; ") : Object.keys(heads).join(", ")}`, key: `${run.id}:queue-slow:${id}:${st.runs}` });
      this.store.save();
    }
    // A passive merge wait whose PRs are neither queued nor tested after `stall_minutes` will never merge by itself.
    if (st.gate?.passive && def.stall_minutes && def.on.stalled && merged < Object.keys(heads).length && this.ports.now() - (st.gate.openedAt ?? this.ports.now()) >= def.stall_minutes * 60_000) {
      const stuck: string[] = [];
      for (const url of Object.keys(heads)) {
        const f = await this.ports.prFacts(url);
        if (f.state === "open" && !f.queued && (f.ci === "none" || f.ci === "red")) stuck.push(`${url} (${f.ci === "none" ? "no CI run on its head" : "CI red"}, not in the merge queue)`);
      }
      if (stuck.length) {
        await this.exclusive(run.id, async () => {
          if (run.stage !== id || st.status !== "waiting" || !st.gate?.passive) return;
          st.status = "done";
          st.verdict = "stalled";
          st.summary = `not merging by itself after ${def.stall_minutes} min: ${stuck.join("; ")}`;
          st.gate = null;
          run.status = "running";
          run.waitingFor = null;
          this.log(run, "merge_stalled", id, st.summary);
          await this.go(run, id, def.on.stalled!, "merge wait stalled");
        });
        return;
      }
    }
    if (merged === Object.keys(heads).length && def.on.merged) {
      await this.exclusive(run.id, async () => {
        if (run.stage !== id || st.status !== "waiting" || !st.gate) return;
        if (st.gate.itemId) this.ports.withdraw(st.gate.itemId, "merged on GitHub");
        st.status = "done";
        st.verdict = "merged";
        st.summary = "merged on GitHub";
        st.gate = null;
        run.status = "running";
        this.log(run, "merged", id, null);
        await this.go(run, id, def.on.merged, "merged on GitHub");
      });
    }
  }

  /**
   * A merge wait (`wait = "merge"`) watches each PR it saw in the merge queue: one that is out of it for LEFT_QUEUE_POLLS reads in a
   * row while still open (auto-merge off, removed from the queue) is said once per PR head, and the wait goes on (OPS-378: a dequeued
   * PR sat unnoticed until a person re-queued it). A "merged" answer that found the PR queued has its own path (`gate.queued`).
   */
  private watchLeftQueue(run: Run, id: string, url: string, f: PrFacts): void {
    const gate = run.stages[id].gate!;
    if (f.queued) {
      (gate.inQueue ??= {})[url] = true;
      if (gate.outPolls?.[url]) gate.outPolls[url] = 0;
      return;
    }
    if (f.queued !== false || !gate.inQueue?.[url] || gate.leftNoticed?.[url] === f.head) return;
    const polls = ((gate.outPolls ??= {})[url] ?? 0) + 1;
    gate.outPolls[url] = polls;
    if (polls < LEFT_QUEUE_POLLS) return this.store.save();
    (gate.leftNoticed ??= {})[url] = f.head;
    delete gate.inQueue[url];
    delete gate.outPolls[url];
    this.log(run, "merge_left_queue", id, `${url} left the merge queue without merging (head ${f.head.slice(0, 12)})`);
    this.notify(run, { kind: "waiting", stage: id, reason: `${url} left the merge queue without merging (head ${f.head.slice(0, 12)}): re-queue it, or say what to do with the run`, key: `${run.id}:left-queue:${id}:${url}:${f.head}` });
    this.store.save();
  }

  /**
   * A wait for a merge that lasted `expires_in_minutes`: follow the `expired` edge. A PR set still in the merge queue (every PR
   * merged or queued, none dequeued) is not stuck, the queue is just slow: the wait is re-armed for another `expires_in_minutes`
   * instead (decision 9b98fade: wait-queue expired into the human merge gate while GitHub was still merging).
   */
  private async expireMergeWait(run: Run, id: string): Promise<void> {
    const st = run.stages[id];
    const def = this.stageDef(run, id) as GateStage;
    if (!st.gate?.passive || !def.expires_in_minutes || this.ports.now() - (st.gate.expiresFrom ?? st.gate.openedAt ?? this.ports.now()) < def.expires_in_minutes * 60_000) return;
    await this.exclusive(run.id, async () => {
      if (run.stage !== id || st.status !== "waiting" || !st.gate?.passive) return;
      const queued = await this.stillQueued(Object.keys(st.gate.heads));
      if (queued === "unknown") return; // GitHub did not answer: expire on a later tick, not on a guess
      if (queued) {
        st.gate.expiresFrom = this.ports.now();
        st.gate.rearms = (st.gate.rearms ?? 0) + 1;
        this.log(run, "merge_wait_rearmed", id, `still in the merge queue after ${def.expires_in_minutes} min: waiting ${def.expires_in_minutes} min more (re-arm ${st.gate.rearms})`);
        this.store.save();
        return;
      }
      const why = def.context ? this.r(run, def.context) : "";
      st.status = "done";
      st.verdict = "expired";
      st.summary = `not merged after ${def.expires_in_minutes} min${why ? `. ${why}` : ""}`;
      st.endedAt = this.ports.now();
      st.gate = null;
      run.status = "running";
      run.waitingFor = null;
      this.log(run, "gate_answered", id, `expired after ${def.expires_in_minutes} min`);
      await this.go(run, id, def.on.expired, "merge wait expired");
    });
  }

  /**
   * Every PR is merged or in a merge queue, and at least one is still queued (read fresh; a read that fails for good is "not
   * queued", a transient failure is "unknown").
   */
  private async stillQueued(urls: string[]): Promise<boolean | "unknown"> {
    let queued = 0;
    for (const url of urls) {
      let transient = false;
      const f = await this.ports.prFacts(url, { maxAgeMs: 0 }).catch((e) => ((transient = isTransientError(e)), null));
      if (transient) return "unknown";
      if (!f) return false;
      if (f.state === "merged") continue;
      // Auto-merge alone with red CI never merges: only a PR with a queue place, or auto-merge on a head that is not red, counts.
      if (f.state === "open" && f.queued === true && (f.queuePosition !== undefined || f.ci !== "red")) queued += 1;
      else return false;
    }
    return queued > 0;
  }

  /** Every PR of the list is merged on GitHub (read fresh; an empty list or a read that fails is "no"). */
  private async allMerged(urls: string[]): Promise<boolean> {
    if (!urls.length) return false;
    for (const url of urls) {
      const f = await this.ports.prFacts(url, { maxAgeMs: 0 }).catch(() => null);
      if (f?.state !== "merged") return false;
    }
    return true;
  }

  /** An approval gate (criteria) nobody answered: one more mail through the run's event mails, at most MAX_REMINDERS. */
  private remindGate(run: Run, id: string): void {
    const st = run.stages[id];
    const def = this.stageDef(run, id) as GateStage;
    const gate = st.gate;
    const every = (this.ports.settings().criteriaReminderMinutes ?? 0) * 60_000;
    if (!gate || !def.criteria || !gate.itemId || !gate.openedAt || every <= 0 || (gate.reminders ?? 0) >= MAX_REMINDERS) return;
    const now = this.ports.now();
    if (now - (gate.remindedAt ?? gate.openedAt) < every) return;
    gate.reminders = (gate.reminders ?? 0) + 1;
    gate.remindedAt = now;
    this.log(run, "gate_reminder", id, `${gate.reminders}/${MAX_REMINDERS}`);
    this.store.save();
    this.notify(run, { kind: "waiting", stage: id, reason: `reminder ${gate.reminders}/${MAX_REMINDERS}: still waiting ${Math.round((now - gate.openedAt) / 60_000)} min for your answer: ${clip(this.r(run, def.question), 200)} (inbox ${gate.itemId})`, key: `${run.id}:gate:${gate.itemId}:reminder:${gate.reminders}` });
  }

  // ---- views ----

  require(id: string): Run {
    const run = this.store.get(id);
    if (!run) throw new UsageError(`No run "${id}".`);
    return run;
  }

  view(run: Run): RunView {
    const stages: StageView[] = run.def.stage.map((def) => {
      const st = run.stages[def.id] ?? freshStage();
      const agent = (def.kind ?? "agent") === "agent" ? (def as AgentStage) : null;
      return {
        id: def.id,
        kind: def.kind ?? "agent",
        role: agent?.role ?? null,
        status: st.status,
        runs: st.runs,
        attempts: st.attempts,
        maxAttempts: agent ? agent.max_attempts + st.extra : null,
        maxRuns: agent ? agent.max_runs + st.extra : null,
        agentId: st.agentId,
        verdict: st.verdict,
        summary: st.summary,
      };
    });
    return {
      id: run.id,
      blueprint: run.blueprint,
      status: run.status,
      stage: run.stage,
      vars: run.vars,
      label: runLabel(run),
      requestedBy: run.requestedBy,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      endedAt: run.endedAt,
      error: run.error,
      waitingFor: run.waitingFor,
      suspended: run.suspended
        ? { reason: run.suspended.reason, since: run.suspended.at, by: run.suspended.by, pods: run.suspended.pods, quota: run.suspended.usageLimit ? { source: run.suspended.usageLimit.source, rule: run.suspended.usageLimit.rule, resumeAt: run.suspended.usageLimit.resumeAt } : null }
        : null,
      pmPending: run.pm.pending,
      escalations: Object.keys(run.escalations ?? {}),
      parent: run.parent,
      stages,
      history: run.history.slice(-200),
    };
  }
}

export { TERMINALS };

const MAX_POD_START_FAILURES = 2;
