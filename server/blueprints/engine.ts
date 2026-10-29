import { flakeReason, flakeSummary, isBusyError, isQuotaError, MAX_BUSY_RETRIES, quotaBackoffMs, SESSION_GONE } from "./flake";
import { createHash } from "node:crypto";
import type { StageKindContext, StageOutcome } from "../extensions";
import { TERMINALS, stageVerdicts, type AgentStage, type Blueprint, type CallStage, type GateStage, type BlueprintStage, type Stage } from "../../shared/blueprints/blueprint";
import type { RunView, StageView } from "../../shared/blueprints/run";
import type { Run, RunStore, StageState } from "./store";
import { condition, render } from "./template";
import { workspaceTitle } from "../workspace-title";
import { PostRun } from "./post";

export class UsageError extends Error {}
export class NotFoundError extends UsageError {}

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
}

export type GateState = {
  status: "pending" | "answered" | "expired" | "withdrawn" | "archived";
  optionId: string | null;
  text: string | null;
  by: string | null;
} | null;

export interface Ports {
  now(): number;
  spawn(o: { idempotencyKey: string; role: string; prompt: string; title: string; workspaceTitle?: string; cwd?: string; labels: Record<string, string>; env: Record<string, string>; /** Overrides the Blueprints runtime setting for this agent. */ runtime?: "kubernetes" | "local"; joinWorkspaceId?: string }): Promise<{ agentId: string; workspaceId?: string | null }>;
  send(agentId: string, text: string): Promise<void>;
  /** A new run exists (the Supervisor wakes on it). */
  runStarted?(run: Run): void;
  /** Information for an agent (not a task): Agents Mail when installed, else `send`. */
  report?(agentId: string, report: { subject: string; body: string; kind: string }): Promise<void>;
  /** Settings of the event mails, the retro and the janitor. */
  post?(): PostSettings;
  /** Archive a workspace (the pod of a Kubernetes agent). */
  archiveWorkspace?(workspaceId: string): Promise<void>;
  /** Suspend the pod of a workspace (volume kept). `busy` says why it was refused (an agent is running in it). Absent: nothing to suspend. */
  suspendWorkspace?(workspaceId: string, force: boolean): Promise<{ ok: boolean; message?: string }>;
  /** Wake a suspended pod ahead of the prompt that would wake it anyway. */
  wakeWorkspace?(workspaceId: string): Promise<void>;
  /** `git status --short` of the workspace, for the history only (5 s at most, never throws): it never keeps a workspace. */
  trace?(workspaceId: string): Promise<string>;
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
  prFacts(url: string): Promise<PrFacts>;
  /** A Factory or extension tool by name, else null. */
  tool(name: string): ((args: Record<string, unknown>) => Promise<unknown> | unknown) | null;
  stageKind(kind: string): ((ctx: Omit<StageKindContext, "paseo" | "services" | "signal">) => Promise<StageOutcome>) | null;
  blueprint(name: string): { blueprint: Blueprint; sha: string } | undefined;
  /** Static checks at start: a message when the run could not possibly start its workers (no working directory...). */
  preflight?(def: Blueprint, at: string): string | null;
  settings(): { defaultCwd: string | undefined; pmRole: string; idleGraceSeconds: number; archiveOnFinish: boolean; shareWorkspace?: boolean; flakeRetries?: number; runsMailTo?: string; criteriaReminderMinutes?: number };
}

export interface PostSettings {
  /** Who gets the event mails ("" = nobody). */
  eventsMailTo: string;
  retro: { enabled: boolean; mailTo: string; role: string; maxUsd: number; timeoutMinutes: number; skipTrivial: boolean };
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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const freshStage = (): StageState => ({
  status: "pending",
  runs: 0,
  attempts: 0,
  extra: 0,
  flakes: 0,
  flakeReasons: [],
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

  constructor(
    readonly store: RunStore,
    private readonly ports: Ports,
  ) {
    this.observer = new PostRun(store, ports);
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
    if (this.store.suspended()) return;
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
        throw new UsageError(`${name} must be confirmed before this blueprint changes code: check it exists (Linear) and pass ${name}_confirmed=true.`);
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
    else for (const id of new Set([run.ownerAgentId, run.pmAgentId].filter((x): x is string => !!x))) void (this.ports.report ? this.ports.report(id, { subject: `Run ${run.id} ${status}`, body: text, kind: "run" }) : this.ports.send(id, text)).catch(() => undefined);
    if (status !== "done" && !opts.quiet) this.notify(run, { kind: status, stage: run.stage, reason: error ?? status, key: `${run.id}:${status}` });
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
    st.runs += 1;
    st.attempts = 0;
    st.flakes = 0;
    st.flakeReasons = [];
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
    return `Factory · ${run.blueprint} · ${run.vars.ticket || run.vars.incident_id || run.id}`;
  }

  /** Stop the run where it is with a reason, ask the human through the Inbox, and wait for `blueprint_resume`. */
  private pause(run: Run, id: string, reason: string): void {
    run.status = "paused";
    run.error = reason;
    run.waitingFor = `a person: ${reason}`;
    this.log(run, "paused", id, reason);
    this.store.save();
    this.notify(run, { kind: "waiting", stage: id, reason: `paused for a person: ${reason}`, key: `${run.id}:paused:${id}:${run.history.length}` });
    this.escalate(run, id, reason, "setup");
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
    return run.vars.ticket || run.vars.incident_id || run.blueprint;
  }

  /** Run id, blueprint and a short summary of its vars (not the internal *_confirmed flags). */
  private runFacts(run: Run): string {
    const vars = Object.entries(run.vars).filter(([k]) => !k.endsWith("_confirmed")).map(([k, v]) => `${k}=${clip(String(v), 80)}`).join(", ");
    return `Run: ${run.id}\nBlueprint: ${run.blueprint}${vars ? `\nVars: ${clip(vars, 300)}` : ""}`;
  }

  private async notifyPm(run: Run, text: string): Promise<void> {
    // With runs.notifyMailTo set, a judgement request is mailed there (queued) instead of interrupting the starter or spawning a PM.
    const mailTo = this.ports.settings().runsMailTo?.trim();
    if (mailTo && this.ports.report) {
      await this.ports.report(mailTo, { subject: `Run ${run.id} ${this.runLabel(run)} needs PM`, body: `${this.runFacts(run)}\n${text}`, kind: "run" }).catch((e) => console.error("blueprints: PM mail failed", e));
      return;
    }
    if (run.pmAgentId && (await this.ports.agentState(run.pmAgentId)) !== "gone") {
      await this.ports.send(run.pmAgentId, text).catch((e) => console.error("blueprints: PM notice failed", e));
      return;
    }
    const role = this.ports.settings().pmRole;
    try {
      const { agentId, workspaceId } = await this.ports.spawn({
        idempotencyKey: `${run.id}:pm:${Object.keys(run.pm.judged).length}`,
        role,
        prompt: text,
        title: `PM ${run.blueprint} ${run.id}`,
        workspaceTitle: workspaceTitle(role, run.vars, `${run.blueprint} ${run.id}`),
        cwd: this.ports.settings().defaultCwd,
        labels: { "paseo.factory": "1", "paseo.factory.blueprint": run.blueprint, "paseo.factory.run": run.id, "paseo.factory.role": role, "paseo.factory.stage": "pm" },
        env: { PASEO_AGENT_ROLE: role, PASEO_FACTORY_RUN: run.id },
      });
      run.pmAgentId = agentId;
      this.registerAgent(run, agentId, role, "pm", workspaceId);
      this.store.save();
    } catch (error) {
      // No PM to ask (no pm role, no working directory...): go straight to the human with the reason.
      const stage = run.pm.pending?.stage ?? run.stage ?? "?";
      run.pm.pending = null;
      this.pause(run, stage, `exhausted (${run.stages[stage]?.summary ?? "no summary"}) and no PM could be started: ${(error as Error).message}`);
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
  async suspend(runId: string, input: { reason: string; by: string; force?: boolean }): Promise<Run> {
    const run = this.require(runId);
    return this.exclusive(run.id, () => this.doSuspend(run, input));
  }

  private async doSuspend(run: Run, input: { reason: string; by: string; force?: boolean }): Promise<Run> {
    if (run.status === "done" || run.status === "failed" || run.status === "aborted") throw new UsageError(`Run ${run.id} is already ${run.status}.`);
    if (run.status === "suspended") return run;
    const now = this.ports.now();
    const pods: string[] = [];
    run.suspended = { reason: input.reason, at: now, by: input.by, prevStatus: run.status, pods };
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
      else if (!this.ports.suspendWorkspace) pods.push(`worker ${st.agentId}: pod ${workspaceId} not suspended (no Kubernetes Runtime handle)`);
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
    run.status = run.suspended?.prevStatus ?? "running";
    run.suspended = null;
    const id = run.stage;
    const st = id ? run.stages[id] : undefined;
    if (input.note && st) st.notes.push(input.note);
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

  private composePrompt(run: Run, id: string, def: AgentStage, st: StageState, why: "start" | "nudge" | "retry" | "wake", facts: string): string {
    const parts: string[] = [];
    if (why === "wake") {
      parts.push(`Factory: run ${run.id} was suspended and is resumed. Continue stage "${id}" where you stopped (check the repository and PR state first), then call blueprint_verdict. Do not end your turn without it.`);
    } else if (why === "nudge") {
      parts.push(`Factory: you ended your turn without giving a verdict for stage "${id}" of run ${run.id}. Finish the work if needed, then call blueprint_verdict. Do not end your turn without it.`);
    } else {
      parts.push(this.r(run, def.prompt));
    }
    if (st.notes.length) parts.push(`## Notes from the PM\n${st.notes.map((n) => `- ${n}`).join("\n")}`);
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
    return `## GitHub facts (read by the Factory just now, not reported by a worker)\n${lines.join("\n")}`;
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

  private async dispatch(run: Run, id: string, why: "start" | "nudge" | "retry" | "wake", opts: { free?: boolean; fresh?: boolean; archiveOld?: boolean; attach?: string } = {}): Promise<void> {
    if (run.status === "suspended") return;
    const def = this.stageDef(run, id) as AgentStage;
    const st = run.stages[id];
    if (!opts.free) st.attempts += 1;
    if (st.attempts > def.max_attempts + st.extra) return this.exhausted(run, id, `${st.attempts - 1} attempts used (max_attempts ${def.max_attempts})`);
    st.status = "entering";
    st.verdict = null;
    this.store.save();

    const facts = await this.prFactsBlock(run, def);
    let prompt = this.composePrompt(run, id, def, st, why, facts);
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
          idempotencyKey: `${run.id}:${id}:${st.runs}:${st.attempts}${st.flakes ? `:f${st.flakes}` : ""}`,
          role: def.role,
          prompt: replaced ? `${prompt}\n\nNote: the worker that held this role earlier is gone; you are its replacement. Read the repository and PR state before continuing.` : prompt,
          title: `${run.blueprint} · ${id} · ${run.vars.ticket || run.id}`,
          workspaceTitle: workspaceTitle(def.role, run.vars, `${run.blueprint} ${run.id}`),
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
      if (flake && POD_START_FLAKES.has(flake)) {
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
    st.status = "running";
    st.quotaRetry = null;
    st.podStartFailures = 0;
    if (st.wardenTask) this.ports.wardenDone(st.wardenTask, "redispatched");
    st.wardenTask = st.agentId ? this.ports.wardenRegister({ agentId: st.agentId, task: `blueprint ${run.blueprint} run ${run.id} stage ${id}: call blueprint_verdict when done` }) : null;
    this.store.save();
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
  private async agentFailed(run: Run, id: string, detail: string): Promise<void> {
    const def = this.stageDef(run, id) as AgentStage;
    const st = run.stages[id];
    const reason = flakeReason(detail);
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

  /** The stage's worker ended a turn. A verdict already given makes this a no-op. */
  turnEnded(agentId: string, outcome: { kind: "completed" | "failed" | "canceled"; message?: string }): Promise<void> {
    if (this.store.all().some((r) => r.retiring?.includes(agentId))) return this.flushRetired(agentId);
    const run = this.store.active().find((r) => r.stage && r.stages[r.stage]?.agentId === agentId && r.stages[r.stage].status === "running");
    if (!run) return Promise.resolve();
    return this.exclusive(run.id, async () => {
      const id = run.stage;
      if (!id || run.stages[id]?.agentId !== agentId || run.stages[id].status !== "running" || run.status !== "running") return;
      const st = run.stages[id];
      if (outcome.kind === "canceled") return; // someone interrupted it on purpose
      st.lastNudgeAt = this.ports.now();
      this.log(run, "turn_ended", id, outcome.kind === "failed" ? `failed: ${outcome.message ?? ""}` : "no verdict");
      if (outcome.kind === "failed") return this.agentFailed(run, id, outcome.message ?? "turn failed");
      return this.dispatch(run, id, "nudge");
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
    if (run.waitingFor !== text) {
      run.waitingFor = text;
      this.log(run, "worker_waiting", run.stage, text);
      this.store.save();
    }
    return { stage: run.stage! };
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
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) throw new UsageError(`data.pr_urls: "${url}" is not a GitHub pull request URL.`);
    }
    const checks = def.verify?.[verdict] ?? [];
    const toCheck = checks.length || urls.length ? (urls.length ? urls : this.prUrls(run, def.pr_urls_from)) : [];
    for (const url of toCheck) {
      let f: PrFacts;
      try {
        f = await this.ports.prFacts(url);
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
      const key = `${run.vars.ticket || run.blueprint}:${id}:${criteriaSha}`;
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
      for (const url of this.r(run, def.pr).split(",").map((s) => s.trim()).filter(Boolean)) {
        const f = await this.ports.prFacts(url);
        heads[url] = f.head;
        facts += `\n- ${url} @ ${f.head.slice(0, 12)}: ${f.state}, CI ${f.ci}`;
      }
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
        await this.doResume(run, { stage: info.stage, extraAttempts: gate.optionId === "resume3" ? 3 : gate.optionId === "resume1" ? 1 : 0 });
        return;
      default:
        // "Other…": the text goes to the worker as a note and the stage gets one more try.
        await this.doResume(run, { stage: info.stage, extraAttempts: 1, note: gate.text ? `Instruction from the human: ${gate.text}` : undefined });
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
        st.verdict = "expired";
        run.status = "running";
        return this.go(run, id, def.on.expired ?? def.on.exhausted ?? "failed", "gate expired");
      }
      const answer = gate.optionId ?? "answered";
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
      if (def.pr && Object.keys(st.gate!.heads).length) {
        const verdict = await this.prGateCheck(run, id, def, answer);
        if (verdict === "refused") return;
      }
      st.verdict = answer;
      st.summary = gate.text ?? null;
      st.status = "done";
      st.endedAt = this.ports.now();
      run.status = "running";
      run.waitingFor = null;
      if (st.gate?.criteriaSha && /approv|yes|ok/i.test(answer)) {
        this.store.approve(`${run.vars.ticket || run.blueprint}:${id}:${st.gate.criteriaSha}`, answer, gate.by ?? "human", this.ports.now());
      }
      this.log(run, "gate_answered", id, `${answer} by ${gate.by ?? "?"}`);
      const next = def.on[answer] ?? def.on.default;
      if (!next) return this.finish(run, "failed", `gate ${id}: no edge for answer "${answer}"`);
      return this.go(run, id, next, `answer ${answer}`);
    }
  }

  /** "merged" must be true on GitHub. Anything else on a PR gate is checked for a head that moved meanwhile. */
  private async prGateCheck(run: Run, id: string, def: GateStage, answer: string): Promise<"ok" | "refused"> {
    const st = run.stages[id];
    const heads = st.gate!.heads;
    for (const [url, head] of Object.entries(heads)) {
      const f = await this.ports.prFacts(url);
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
      this.log(run, "no_such_kind", id, def.kind ?? "");
      return this.finish(run, "failed", `stage ${id}: no extension provides the stage kind "${def.kind}"`);
    }
    st.status = "running";
    this.store.save();
    const { id: _id, kind: _k, on: _o, skip_if: _s, title: _t, ...params } = def as Record<string, unknown> & Stage;
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
    if (run.pm.pending && !(await this.hasLivePm(run))) {
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
    for (const run of this.store.active()) {
      const id = run.stage;
      if (!id) continue;
      const st = run.stages[id];
      if (!st) continue;
      try {
        if (st.status === "entering" && st.quotaRetry && now >= st.quotaRetry.at && run.status === "running") {
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
        } else if (st.status === "waiting" && st.gate && (st.gate.itemId || st.gate.passive) && Object.keys(st.gate.heads).length) {
          await this.pollPrGate(run, id);
          if (st.gate?.passive) await this.expireMergeWait(run, id);
        } else if (st.status === "waiting" && st.gate?.itemId) this.remindGate(run, id);
        else if (st.status === "running" && run.status === "running" && (this.stageDef(run, id).kind ?? "agent") === "agent" && st.agentId) {
          const grace = this.ports.settings().idleGraceSeconds * 1000;
          if (now - (st.lastNudgeAt ?? st.startedAt ?? now) < grace) continue;
          const state = await this.ports.agentState(st.agentId);
          if (state === "running") continue;
          await this.exclusive(run.id, async () => {
            if (run.stage !== id || st.status !== "running" || st.lastNudgeAt !== null && now - st.lastNudgeAt < grace) return;
            st.lastNudgeAt = now;
            this.log(run, "stalled", id, state);
            if (state === "gone") await this.agentFailed(run, id, "worker gone");
            else await this.dispatch(run, id, "nudge");
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
    for (const [url, head] of Object.entries(heads)) {
      const f = await this.ports.prFacts(url);
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
    // Queued but still not merged after `stall_minutes` (15 by default): say so once, keep waiting; never a new question.
    if (st.gate?.queued && !st.gate.slowNoticed && merged < Object.keys(heads).length && this.ports.now() - (st.gate.openedAt ?? this.ports.now()) >= (def.stall_minutes ?? 15) * 60_000) {
      st.gate.slowNoticed = true;
      const mins = Math.round((this.ports.now() - (st.gate.openedAt ?? this.ports.now())) / 60_000);
      this.log(run, "merge_queue_slow", id, `still in the merge queue after ${mins} min`);
      this.notify(run, { kind: "waiting", stage: id, reason: `still in the merge queue after ${mins} min: ${Object.keys(heads).join(", ")}`, key: `${run.id}:queue-slow:${id}:${st.runs}` });
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

  /** A wait for a merge that lasted `expires_in_minutes`: follow the `expired` edge. */
  private async expireMergeWait(run: Run, id: string): Promise<void> {
    const st = run.stages[id];
    const def = this.stageDef(run, id) as GateStage;
    if (!st.gate?.passive || !def.expires_in_minutes || this.ports.now() - (st.gate.openedAt ?? this.ports.now()) < def.expires_in_minutes * 60_000) return;
    await this.exclusive(run.id, async () => {
      if (run.stage !== id || st.status !== "waiting" || !st.gate?.passive) return;
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
      requestedBy: run.requestedBy,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      endedAt: run.endedAt,
      error: run.error,
      waitingFor: run.waitingFor,
      suspended: run.suspended ? { reason: run.suspended.reason, since: run.suspended.at, by: run.suspended.by, pods: run.suspended.pods } : null,
      pmPending: run.pm.pending,
      escalations: Object.keys(run.escalations ?? {}),
      parent: run.parent,
      stages,
      history: run.history.slice(-200),
    };
  }
}

export { TERMINALS };

/** Flake reasons that mean the worker's pod never came up. */
const POD_START_FLAKES = new Set(["pod did not start", "pod not ready", "bridge.mjs not written", "container not found"]);
const MAX_POD_START_FAILURES = 2;
