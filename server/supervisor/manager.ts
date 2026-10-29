import { randomBytes } from "node:crypto";
import type { SupervisorRequest, SupervisorStatus } from "../../shared/supervisor/rpc";
import type { SupervisorSettings } from "../../shared/supervisor/settings";
import type { Issue } from "../host";
import { digestMessage, nextDigest } from "./digest";
import { appendMemory, restartAllowed, type SupervisorState } from "./state";

export const SUPERVISOR_LABEL = "paseo.factory.supervisor";

/** What the Factory is doing, as far as the Supervisor's idle check cares. */
export interface FactoryActivity {
  /** Runs that have not ended. */
  runs: { id: string; label: string; status: "running" | "waiting" | "paused"; stage: string | null; detail: string | null }[];
  /** Stage agents of those runs that are still alive. */
  liveStageAgents: number;
}

export interface SupervisorPorts {
  now(): number;
  /** Create the agent (in its own workspace) on the daemon. */
  create(o: { idempotencyKey: string; prompt: string; cwd: string }): Promise<{ agentId: string; workspaceId: string | null }>;
  send(agentId: string, text: string): Promise<void>;
  /** Information for the Supervisor (digests): Agents Mail when installed, else `send`. */
  report?(agentId: string, report: { subject: string; body: string; kind: string }): Promise<void>;
  agentState(agentId: string): Promise<"running" | "idle" | "gone">;
  /** Archive the agent AND its workspace (looked up from the agent when `workspaceId` is null). */
  archive(agentId: string, workspaceId: string | null): Promise<void>;
  /** Resolve when the agent has ended its current turn, or after `ms`. */
  awaitTurn(agentId: string, ms: number): Promise<void>;
  factory(): Promise<FactoryActivity>;
  /** Tell the Assistant about a problem that did not wake the Supervisor (Agents Mail when installed). */
  flag?(report: { subject: string; body: string; kind: string }): Promise<void>;
  /** While the Supervisor is disabled: one short mail about an expired lease or a dropped extension (to events.mailTo). */
  notify?(subject: string, body: string): void | Promise<void>;
  issues(): Promise<Issue[]>;
  nameOf(agentId: string): Promise<string>;
  restartExtension(id: string): Promise<string>;
  settings(): SupervisorSettings;
  defaultCwd(): string | undefined;
}

const INTRO =
  "You are the Factory Supervisor, the agent that watches the Factory itself. You run on demand: the Factory wakes you when it needs you and archives you when it is idle, " +
  "so keep what a successor must know with supervisor_note(text). The Factory sends you digests of problems " +
  "(stuck or failed runs with no PM, spawn failures, lease contention, extension health, config errors) and requests from other agents " +
  "(\"Supervisor request <id> from <name>\": answer with supervisor_reply). Follow your role file.";

export const HANDOFF_PROMPT =
  "Factory: the Factory is idle and your session is about to be archived. Write your handoff now: call supervisor_note(text) with what your next session must know " +
  "(open threads, what you promised or are waiting for, things to watch, decisions of the user). Then end your turn. A new session is created on demand with your notes.";

const HANDOFF_MS = 60_000;
const MAX_INTRO = 14_000;

/** Why the Factory is busy (empty: idle). A paused run counts until the Supervisor has been told about it. */
export function busyReasons(i: { activity: FactoryActivity; told: Record<string, number>; unanswered: number; undeliveredDigest: boolean; outbox: number; midTurn: boolean }): string[] {
  const out: string[] = [];
  for (const r of i.activity.runs) {
    if (r.status === "paused" && i.told[`run:${r.id}:paused`] !== undefined) continue;
    out.push(r.status === "paused" ? `run ${r.id} is paused and not reported yet` : `run ${r.id} is ${r.status}`);
  }
  if (i.activity.liveStageAgents > 0) out.push(`${i.activity.liveStageAgents} live stage agent${i.activity.liveStageAgents === 1 ? "" : "s"}`);
  if (i.unanswered > 0) out.push(`${i.unanswered} unanswered request${i.unanswered === 1 ? "" : "s"}`);
  if (i.undeliveredDigest) out.push("a digest is not delivered");
  if (i.outbox > 0) out.push(`${i.outbox} message${i.outbox === 1 ? "" : "s"} from the user not delivered`);
  if (i.midTurn) out.push("the Supervisor is mid-turn");
  return out;
}

/** Issues that only get flagged while the Supervisor is archived: lease contention, and anything it was already told. */
export function flagOnly(issue: Issue, alreadyTold: boolean): boolean {
  return alreadyTold || issue.key.startsWith("lease:");
}

type AskResult =
  | { status: "answered"; request: string; answer: string }
  | { status: "pending"; request: string; note: string }
  | { status: "queued"; request: string; note: string }
  | { status: "disabled"; note: string };

export const DISABLED_NOTE = "Supervisor disabled; its notices go to the blueprints events.mailTo (else the supervisor reportTo).";

/** Issues mailed while the Supervisor is disabled: a lease that expired without a release, an extension that was dropped. */
export function noticeOf(issue: Issue): { subject: string; body: string } | null {
  if (/^lease:.+:expired:/.test(issue.key)) return { subject: `Factory: ${issue.text.split(" (")[0]}`.slice(0, 200), body: issue.text };
  if (/^ext:.+:dropped$/.test(issue.key)) return { subject: `Factory: extension ${issue.key.slice(4, -8)} dropped`, body: issue.text };
  return null;
}

/** The Supervisor agent, on demand: created when the Factory needs it, archived when idle, briefed from the store. */
export class Supervisor {
  private readonly waiters = new Map<string, (answer: string) => void>();
  private readonly deliveryWaiters = new Map<string, () => void>();
  private starting: Promise<void> | null = null;
  private archiving: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  /** A wake arrived while the handoff turn ran: keep the agent. */
  private wakeDuringHandoff = false;
  private idleSince: number | null = null;
  error: string | null = null;
  lastDigestAt: number | null = null;
  private lastIssues: Issue[] = [];

  constructor(
    readonly state: SupervisorState,
    private readonly ports: SupervisorPorts,
  ) {
    // The agent of an earlier deploy (before sessions were tracked) becomes session 1 and ages out like any other.
    const data = state.data;
    if (data.agentId && !data.incarnations.some((i) => i.agentId === data.agentId)) {
      const n = Math.max(data.lastIncarnation, 0) + 1;
      data.lastIncarnation = n;
      data.incarnations.push({ n, agentId: data.agentId, workspaceId: data.workspaceId, startedAt: data.startedAt ?? ports.now(), endedAt: null, reason: null });
    }
  }

  /** The Supervisor's settings, for the modules that route to it (the run PMs' escalation target). */
  config(): SupervisorSettings {
    return this.ports.settings();
  }

  // ---- lifecycle ----

  /** Create the agent when there is none or it is gone, then deliver what waits for it. `restart` replaces a live one. */
  ensure(opts: { restart?: boolean } = {}): Promise<void> {
    if (!this.ports.settings().enabled) return Promise.resolve();
    if (this.archiving) this.wakeDuringHandoff = true;
    if (this.starting) return this.starting;
    this.starting = this.doEnsure(opts).finally(() => (this.starting = null));
    return this.starting;
  }

  /** An automatic trigger (a run started, a crash): wake the agent unless that is turned off. Never awaits. */
  wake(): void {
    const s = this.ports.settings();
    if (!s.enabled || !s.autoStart) return;
    void this.ensure().catch((error) => console.error("supervisor: wake failed", error));
  }

  private async doEnsure(opts: { restart?: boolean }): Promise<void> {
    if (this.archiving) await this.archiving.catch(() => undefined);
    const data = this.state.data;
    if (data.agentId) {
      const live = await this.ports.agentState(data.agentId);
      if (live !== "gone" && !opts.restart) {
        this.error = null;
        await this.flushPending();
        return;
      }
      await this.retire(opts.restart ? "restart" : "gone");
    }
    const cwd = this.ports.settings().cwd ?? this.ports.defaultCwd();
    if (!cwd) {
      this.error = "No working directory: set the Supervisor setting cwd (or FACTORY_DEFAULT_CWD).";
      return;
    }
    try {
      data.generation += 1;
      this.state.save();
      const n = data.lastIncarnation + 1;
      const prompt = await this.buildIntro(n);
      const created = await this.ports.create({ idempotencyKey: `supervisor:${data.generation}`, prompt, cwd });
      const now = this.ports.now();
      data.agentId = created.agentId;
      data.workspaceId = created.workspaceId;
      data.startedAt = now;
      data.archivedAt = null;
      data.lastIncarnation = n;
      data.incarnations.push({ n, agentId: created.agentId, workspaceId: created.workspaceId, startedAt: now, endedAt: null, reason: null });
      data.flags = [];
      this.idleSince = null;
      this.error = null;
      this.state.save();
    } catch (error) {
      this.error = `could not start the Supervisor: ${(error as Error).message}`;
      return;
    }
    await this.flushPending();
  }

  /** End the current session: record it, forget the agent, archive the agent and its workspace. */
  private async retire(reason: string): Promise<void> {
    const data = this.state.data;
    const id = data.agentId;
    if (!id) return;
    const workspaceId = data.workspaceId;
    const inc = data.incarnations.find((i) => i.agentId === id && i.endedAt === null);
    if (inc) {
      inc.endedAt = this.ports.now();
      inc.reason = reason;
    }
    data.agentId = null;
    data.workspaceId = null;
    data.archivedAt = this.ports.now();
    this.idleSince = null;
    this.state.save();
    try {
      await this.ports.archive(id, workspaceId);
    } catch (error) {
      console.error("supervisor: archive failed", error);
      this.addFlag(`supervisor:archive-failed:${id}`, `Could not archive the old Supervisor ${id}${workspaceId ? ` (workspace ${workspaceId})` : ""}: ${(error as Error).message}`);
    }
  }

  // ---- idle ----

  /** The Factory is busy while anything needs the Supervisor now or soon. */
  async isFactoryBusy(): Promise<{ busy: boolean; reasons: string[] }> {
    const data = this.state.data;
    const activity = await this.ports.factory();
    const midTurn = data.agentId ? (await this.ports.agentState(data.agentId)) === "running" : false;
    const reasons = busyReasons({
      activity,
      told: data.told,
      unanswered: data.requests.filter((r) => r.answer === null).length,
      undeliveredDigest: data.pendingDigests.length > 0,
      outbox: data.outbox.length,
      midTurn,
    });
    return { busy: reasons.length > 0, reasons };
  }

  /** The Supervisor was switched off: archive an agent that still runs (its notes stay in the store). */
  async disable(): Promise<void> {
    if (this.archiving) await this.archiving.catch(() => undefined);
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.state.data.agentId) await this.retire("disabled");
    this.error = null;
  }

  /** Each digest tick: forget a vanished agent, retry deliveries, archive after the idle delay. */
  async tick(): Promise<void> {
    if (this.archiving || this.starting) return;
    const data = this.state.data;
    if (!data.agentId) {
      this.idleSince = null;
      if (this.hasQueued()) await this.ensure();
      return;
    }
    if ((await this.ports.agentState(data.agentId)) === "gone") {
      await this.retire("gone");
      if (this.hasQueued()) await this.ensure();
      return;
    }
    await this.flushPending();
    const minutes = this.ports.settings().idleArchiveMinutes;
    if (minutes === 0) {
      this.idleSince = null;
      return;
    }
    if ((await this.isFactoryBusy()).busy) {
      this.idleSince = null;
      return;
    }
    this.idleSince ??= this.ports.now();
    if (this.ports.now() - this.idleSince >= minutes * 60_000) await this.archiveIdle();
  }

  private hasQueued(): boolean {
    const data = this.state.data;
    return data.outbox.length > 0 || data.pendingDigests.length > 0 || data.requests.some((r) => r.deliveredAt === null && r.answer === null);
  }

  /** Ask for a handoff note, wait one turn (60 s at most), archive unless something woke the Factory meanwhile. */
  private archiveIdle(): Promise<void> {
    this.wakeDuringHandoff = false;
    this.archiving = (async () => {
      const id = this.state.data.agentId;
      if (!id) return;
      try {
        await this.ports.send(id, HANDOFF_PROMPT);
        await this.ports.awaitTurn(id, HANDOFF_MS);
      } catch (error) {
        console.error("supervisor: handoff failed", error);
      }
      if (this.wakeDuringHandoff || (await this.isFactoryBusy()).busy) {
        this.idleSince = null;
        return;
      }
      await this.retire("idle");
    })().finally(() => {
      this.archiving = null;
      this.wakeDuringHandoff = false;
    });
    return this.archiving;
  }

  // ---- notes ----

  /** supervisor_note: durable notes for the next session, newest kept within 8 KB. */
  note(text: string): string {
    const data = this.state.data;
    data.memory = appendMemory(data.memory, text, this.ports.now());
    this.state.save();
    return data.memory;
  }

  private async buildIntro(n: number): Promise<string> {
    const data = this.state.data;
    const now = this.ports.now();
    const parts = [INTRO, `This is session #${n}${n > 1 ? " (earlier sessions were archived; this is what the Factory kept for you)" : ""}.`];
    parts.push(data.memory.trim() ? `Your notes from earlier sessions:\n${data.memory.trim()}` : "Your notes from earlier sessions: none yet.");
    let issues: Issue[] = this.lastIssues;
    try {
      issues = await this.ports.issues();
      this.lastIssues = issues;
    } catch {
      /* use the last seen */
    }
    parts.push(issues.length ? `Open problems:\n${issues.map((i) => `- ${i.text}`).join("\n")}` : "Open problems: none.");
    const pending = data.requests.filter((r) => r.answer === null && r.deliveredAt !== null);
    if (pending.length) parts.push(`Requests asked to an earlier session and still unanswered:\n${pending.map((r) => `- ${r.id} from "${r.fromName}" (${r.fromId}): ${r.question}`).join("\n")}`);
    const answered = data.requests.filter((r) => r.answer !== null).slice(-5);
    if (answered.length) parts.push(`Last ${answered.length} answered requests:\n${answered.map((r) => `- ${r.id} from "${r.fromName}": ${r.question}\n  answer: ${(r.answer ?? "").slice(0, 300)}`).join("\n")}`);
    if (data.restarts.length) parts.push(`Extension restarts (limit: once per hour per extension):\n${data.restarts.slice(-5).map((r) => `- ${r.extension} ${Math.max(0, Math.round((now - r.at) / 60_000))} min ago`).join("\n")}`);
    try {
      const activity = await this.ports.factory();
      parts.push(activity.runs.length ? `Active runs:\n${activity.runs.map((r) => `- ${r.id} (${r.label}) ${r.status}${r.stage ? ` at ${r.stage}` : ""}${r.detail ? `: ${r.detail}` : ""}`).join("\n")}` : "Active runs: none.");
    } catch {
      /* the summary is a nicety */
    }
    return parts.join("\n\n").slice(0, MAX_INTRO);
  }

  // ---- delivery ----

  /** Deliver what waited for the agent: the digests, the queued requests, the user's messages. */
  flushPending(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const data = this.state.data;
    const id = data.agentId;
    if (!id || (await this.ports.agentState(id)) === "gone") return;
    try {
      while (data.pendingDigests.length > 0) {
        await this.deliverDigest(id, data.pendingDigests[0]);
        data.pendingDigests.shift();
        this.state.save();
      }
      for (const r of data.requests.filter((x) => x.deliveredAt === null && x.answer === null)) {
        await this.ports.send(id, this.requestText(r));
        r.deliveredAt = this.ports.now();
        this.state.save();
        this.deliveryWaiters.get(r.id)?.();
      }
      while (data.outbox.length > 0) {
        await this.ports.send(id, `Message from the user (Supervisor tab): ${data.outbox[0]}`);
        data.outbox.shift();
        this.state.save();
      }
    } catch (error) {
      this.error = `could not reach the Supervisor: ${(error as Error).message}`;
    }
  }

  private async deliverDigest(id: string, digest: { subject: string; body: string }): Promise<void> {
    if (this.ports.report) await this.ports.report(id, { subject: digest.subject, body: digest.body, kind: "digest" });
    else await this.ports.send(id, digest.body);
  }

  private requestText(r: SupervisorRequest): string {
    return `Supervisor request ${r.id} from "${r.fromName}" (${r.fromId}): ${r.question}\nAnswer with supervisor_reply(request="${r.id}", answer="...").`;
  }

  private isLive(): Promise<boolean> {
    const id = this.state.data.agentId;
    return id ? this.ports.agentState(id).then((s) => s !== "gone") : Promise.resolve(false);
  }

  /** A message from the user (Supervisor tab): direct when the agent is up, else queued and the agent is woken. */
  async sendUser(text: string): Promise<{ ok: boolean; message: string | null }> {
    if (!this.ports.settings().enabled) return { ok: false, message: DISABLED_NOTE };
    const data = this.state.data;
    if (!this.archiving && (await this.isLive())) {
      try {
        await this.ports.send(data.agentId!, `Message from the user (Supervisor tab): ${text}`);
        return { ok: true, message: null };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    }
    data.outbox.push(text);
    this.state.save();
    void this.ensure();
    return { ok: true, message: "The Supervisor was archived: waking it up, your message is delivered when it is up." };
  }

  async status(): Promise<SupervisorStatus> {
    const data = this.state.data;
    const live = data.agentId ? await this.ports.agentState(data.agentId) : null;
    const queued = data.outbox.length + data.pendingDigests.length + data.requests.filter((r) => r.deliveredAt === null && r.answer === null).length;
    const waking = this.starting !== null || (!data.agentId && queued > 0 && !this.error);
    const minutes = this.ports.settings().idleArchiveMinutes;
    const busy = data.agentId ? await this.isFactoryBusy() : { busy: false, reasons: [] as string[] };
    return {
      agentId: data.agentId,
      state: !this.ports.settings().enabled
        ? "disabled"
        : this.error
        ? "error"
        : waking
          ? "waking"
          : !data.agentId
            ? data.archivedAt
              ? "archived"
              : "not-started"
            : live === "running"
              ? "running"
              : live === "idle"
                ? "idle"
                : "stopped",
      error: this.error,
      startedAt: data.startedAt,
      issues: this.lastIssues,
      lastDigestAt: this.lastDigestAt,
      restarts: data.restarts.slice(-20),
      requests: data.requests.slice(-30),
      busy,
      idleArchiveAt: data.agentId && minutes > 0 && this.idleSince !== null ? this.idleSince + minutes * 60_000 : null,
      archivedAt: data.agentId ? null : data.archivedAt,
      queued,
      flags: data.flags.slice(-20),
      incarnations: data.incarnations.map(({ n, agentId, startedAt, endedAt, reason }) => ({ n, agentId, startedAt, endedAt, reason })),
    };
  }

  // ---- digest ----

  /** Look for problems; tell the Supervisor about new ones (waking it), flag the ones that must not wake it. */
  async digest(): Promise<void> {
    const settings = this.ports.settings();
    this.lastIssues = await this.ports.issues();
    const data = this.state.data;
    if (!settings.enabled) return this.notify();
    const open = new Set(this.lastIssues.map((i) => i.key));
    const kept = data.flags.filter((f) => open.has(f.key) || f.key.startsWith("supervisor:"));
    if (kept.length !== data.flags.length) {
      data.flags = kept;
      this.state.save();
    }
    const { send, told } = nextDigest(this.lastIssues, data.told, this.ports.now(), settings.repeatMinutes * 60_000);
    if (send.length === 0) {
      if (Object.keys(told).length !== Object.keys(data.told).length) {
        data.told = told;
        this.state.save();
      }
      return;
    }
    const live = await this.isLive();
    let tell = send;
    if (!live) {
      const flagged = send.filter((i) => flagOnly(i, data.told[i.key] !== undefined));
      for (const issue of flagged) this.addFlag(issue.key, issue.text);
      tell = send.filter((i) => !flagged.includes(i));
      if (tell.length > 0 && !settings.autoStart) {
        // Nobody to tell and no automatic wake: keep them untold so they are told once something wakes the Supervisor.
        for (const issue of tell) {
          if (data.told[issue.key] === undefined) delete told[issue.key];
          else told[issue.key] = data.told[issue.key];
        }
        tell = [];
      }
    }
    data.told = told;
    this.state.save();
    if (tell.length === 0) return;
    const digest = { subject: `Factory digest: ${tell.length} problem${tell.length === 1 ? "" : "s"}`, body: digestMessage(tell) };
    if (!live) {
      data.pendingDigests.push(digest);
      this.state.save();
      await this.ensure();
      this.lastDigestAt = this.ports.now();
      return;
    }
    try {
      await this.deliverDigest(data.agentId!, digest);
      this.lastDigestAt = this.ports.now();
    } catch (error) {
      this.error = `could not reach the Supervisor: ${(error as Error).message}`;
    }
  }

  /** Disabled: the lease and extension problems the Supervisor would have watched go to events.mailTo, once each. */
  private notify(): void {
    const data = this.state.data;
    const now = this.ports.now();
    let changed = false;
    for (const issue of this.lastIssues) {
      const notice = noticeOf(issue);
      if (!notice || data.told[issue.key] !== undefined) continue;
      data.told[issue.key] = now;
      changed = true;
      void Promise.resolve(this.ports.notify?.(notice.subject, notice.body)).catch((e) => console.error("supervisor: notice failed", e));
    }
    for (const [key, at] of Object.entries(data.told)) {
      if (now - at > 2 * 3600_000 && !this.lastIssues.some((i) => i.key === key)) {
        delete data.told[key];
        changed = true;
      }
    }
    if (changed) this.state.save();
  }

  private addFlag(key: string, text: string): void {
    const data = this.state.data;
    if (data.flags.some((f) => f.key === key)) return;
    data.flags.push({ key, text, at: this.ports.now() });
    if (data.flags.length > 50) data.flags.splice(0, data.flags.length - 50);
    this.state.save();
    void this.ports.flag?.({ subject: "Factory: a problem to know about (the Supervisor is archived)", body: text, kind: "notice" }).catch(() => undefined);
  }

  // ---- requests from other agents ----

  /**
   * supervisor_ask: record the request, wake the Supervisor without waiting for it, then wait for supervisor_reply.
   * The answer timer starts once the request reached the agent; a request that could not be delivered stays queued.
   */
  async ask(from: { id: string; name: string }, question: string): Promise<AskResult> {
    if (!this.ports.settings().enabled) return { status: "disabled", note: DISABLED_NOTE };
    const data = this.state.data;
    const request: SupervisorRequest = { id: `sq-${randomBytes(3).toString("hex")}`, fromId: from.id, fromName: from.name, question, at: this.ports.now(), answer: null, answeredAt: null, deliveredAt: null };
    data.requests.push(request);
    this.state.save();
    const delivered = new Promise<void>((resolve) => this.deliveryWaiters.set(request.id, resolve));
    const answered = new Promise<string>((resolve) => this.waiters.set(request.id, resolve));
    const ensured = this.ensure().then(() => this.flushPending());
    const reached = await Promise.race([delivered.then(() => true), ensured.then(() => request.deliveredAt !== null)]);
    this.deliveryWaiters.delete(request.id);
    if (!reached) {
      this.waiters.delete(request.id);
      return { status: "queued", request: request.id, note: this.error ? `The Supervisor could not be woken (${this.error}); the request stays queued, poll supervisor_ask_status.` : "The Supervisor is waking up; poll supervisor_ask_status with this request id." };
    }
    const timeoutMs = this.ports.settings().askTimeoutSeconds * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const winner = await Promise.race([answered, new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))]);
    clearTimeout(timer);
    this.waiters.delete(request.id);
    if (winner !== null) return { status: "answered", request: request.id, answer: winner };
    return { status: "pending", request: request.id, note: "The Supervisor has not answered yet; poll supervisor_ask_status with this request id." };
  }

  request(id: string): SupervisorRequest | undefined {
    return this.state.data.requests.find((r) => r.id === id);
  }

  requestStatus(id: string): "queued" | "pending" | "answered" | null {
    const r = this.request(id);
    if (!r) return null;
    return r.answer !== null ? "answered" : r.deliveredAt === null ? "queued" : "pending";
  }

  reply(id: string, answer: string): SupervisorRequest {
    const request = this.request(id);
    if (!request) throw new Error(`No request "${id}".`);
    request.answer = answer;
    request.answeredAt = this.ports.now();
    this.state.save();
    this.waiters.get(id)?.(answer);
    return request;
  }

  // ---- extension restarts ----

  /** At most once an hour per extension; a second request inside the hour tells the Supervisor to ask the user. */
  async restartExtension(id: string): Promise<string> {
    if (!this.ports.settings().enabled) throw new Error(DISABLED_NOTE);
    const now = this.ports.now();
    const allowed = restartAllowed(this.state.data.restarts, id, now);
    if (!allowed.ok) {
      throw new Error(`Extension ${id} was already restarted ${allowed.minutesAgo} min ago (limit: once per hour). Ask the user through inbox_ask what to do.`);
    }
    this.state.data.restarts.push({ extension: id, at: now });
    this.state.save();
    return this.ports.restartExtension(id);
  }
}
