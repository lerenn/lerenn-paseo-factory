import type { WardenSettings } from "../shared/settings";
import type { TaskStatus, TaskView } from "../shared/task";
import { render } from "./template";
import type { Store, Task } from "./store";

/** What the engine does to the outside world; the plugin wires it to the Paseo SDK. */
export interface Actions {
  send(agentId: string, text: string): Promise<void>;
  /** Start/stop observing an agent's timeline; activity must be reported through `Engine.activity`. */
  watch(agentId: string): void;
  unwatch(agentId: string): void;
}

export class Engine {
  private lastSendAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private readonly permissions = new Set<string>();
  /** Agents whose turn is running, and when idle agents' last turn ended. Unknown agents are in neither. */
  private readonly running = new Set<string>();
  private readonly idleSince = new Map<string, number>();
  private readonly permissionSince = new Map<string, number>();
  private readonly lastActivity = new Map<string, number>();
  /** When the coordinator last acted on a child: prompted it, answered its permission, or archived it. */
  private readonly actedAt = new Map<string, number>();
  private readonly ownSendAt = new Map<string, number>();
  /** The event of each supervised child the coordinator was last pinged about. */
  private readonly notified = new Map<string, number>();
  /**
   * Turns triggered by a message from the coordinator (or user): pending until the turn starts,
   * running, and ended. An ended one without an open task is the reply, not a new event.
   */
  private readonly reactPending = new Set<string>();
  private readonly reactRunning = new Set<string>();
  private readonly reactEnded = new Set<string>();

  constructor(
    readonly store: Store,
    private readonly actions: Actions,
    private readonly settings: () => WardenSettings | null,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- registration ----

  register(input: { agentId: string; task: string; intervalMinutes: number; until: number | null; registeredBy: string; source: Task["source"] }): Task {
    const task = this.store.add({ ...input, intervalMinutes: this.effectiveMinutes(input) }, this.now());
    this.actions.watch(task.agentId);
    for (const child of this.store.children(task.agentId)) this.actions.watch(child);
    return task;
  }

  // ---- subagents of a watched agent ----

  /** A child of a watched agent appeared (or was seen for the first time). */
  childSeen(agentId: string): void {
    const parent = this.store.agent(agentId)?.parentId;
    if (parent && this.store.active(parent).length > 0) this.actions.watch(agentId);
  }

  private needsWatch(agentId: string): boolean {
    const agent = this.store.agent(agentId);
    const supervised = !!agent?.parentId && !agent.archived && this.store.active(agent.parentId).length > 0;
    return supervised || this.store.active(agentId).length > 0;
  }

  private unwatchIfIdle(agentId: string): void {
    if (!this.needsWatch(agentId)) this.actions.unwatch(agentId);
  }

  /** A user message in the child's timeline that warden did not send: the coordinator (or the user) acted. */
  userMessage(agentId: string): void {
    if (this.now() - (this.ownSendAt.get(agentId) ?? Number.NEGATIVE_INFINITY) < 15_000) return;
    this.actedAt.set(agentId, this.now());
    this.store.setWaiting(agentId, null);
    this.reactEnded.delete(agentId);
    (this.running.has(agentId) ? this.reactRunning : this.reactPending).add(agentId);
  }

  /** Mark (or, with null, clear) what an agent is waiting on; idle attention for it is suppressed meanwhile. */
  setWaiting(agentId: string, reason: string | null): void {
    this.store.setWaiting(agentId, reason);
  }

  /** A subagent is live while its turn runs; an agent with a live subagent is not pinged for idleness. */
  private busyOrWaiting(agentId: string): boolean {
    return !!this.store.agent(agentId)?.waitingOn || this.store.children(agentId).some((c) => this.running.has(c));
  }

  /** What each child of `parentId` needs from it, and when the parent is pinged if it does not react. */
  private childEvents(parentId: string, s: WardenSettings): { agentId: string; title: string | null; reason: string; since: number; at: number }[] {
    const now = this.now();
    const since0 = Math.min(now, ...this.store.active(parentId).map((t) => t.createdAt));
    const out: { agentId: string; title: string | null; reason: string; since: number; at: number }[] = [];
    const min = (at: number) => Math.max(1, Math.round((now - at) / 60_000));
    for (const child of this.store.children(parentId)) {
      const acted = Math.max(this.actedAt.get(child) ?? 0, since0);
      let event: { since: number; reason: string } | null = null;
      const permissionSince = this.permissionSince.get(child);
      const idle = this.idleSince.get(child);
      if (this.permissions.has(child) && permissionSince !== undefined) {
        event = { since: permissionSince, reason: `waiting on a permission request for ${min(permissionSince)} min` };
      } else if (idle !== undefined && !this.running.has(child)) {
        const tasks = this.store.active(child);
        if (this.store.agent(child)?.waitingOn || (this.reactEnded.has(child) && tasks.length === 0)) continue;
        event = {
          since: idle,
          reason: tasks.length > 0 ? `stopped its turn ${min(idle)} min ago without finishing '${tasks[0].task}'` : `finished its turn ${min(idle)} min ago`,
        };
      } else if (this.running.has(child) && this.lastActivity.has(child)) {
        const tasks = this.store.active(child);
        const hang = (tasks.length > 0 ? Math.min(...tasks.map((t) => this.effectiveMinutes(t, s))) : s.maxIntervalMinutes) * 60_000;
        const at = this.lastActivity.get(child)! + hang;
        event = { since: at, reason: `running with no activity for ${min(this.lastActivity.get(child)!)} min` };
      }
      if (!event || event.since <= acted) continue;
      out.push({ agentId: child, title: this.store.agent(child)?.title ?? null, ...event, at: event.since + s.superviseReactMinutes * 60_000 });
    }
    return out;
  }

  private attention(parentId: string, s: WardenSettings) {
    const now = this.now();
    return this.childEvents(parentId, s).filter((e) => now >= e.at);
  }

  private async childStep(s: WardenSettings): Promise<void> {
    const parents = new Set(this.store.active().map((t) => t.agentId));
    for (const parentId of parents) {
      if (this.store.optedOut(parentId) || this.permissions.has(parentId)) continue;
      const items = this.attention(parentId, s);
      if (!items.some((i) => this.notified.get(i.agentId) !== i.since)) continue;
      for (const i of items) this.notified.set(i.agentId, i.since);
      const lines = items.map((i) => `- '${i.title ?? i.agentId}' (${i.agentId}): ${i.reason}`);
      const task = this.store.active(parentId)[0];
      task.pings += 1;
      task.unanswered += 1;
      this.store.save();
      await this.deliver(parentId, `Warden: ${items.length} subagent${items.length > 1 ? "s need" : " needs"} your attention:\n${lines.join("\n")}`);
      return;
    }
  }

  /** When and why the next ping of an active task fires, or null when none is scheduled. */
  private nextPing(task: Task, s: WardenSettings | null): { at: number; reason: string } | null {
    if (!s?.enabled || task.state !== "active") return null;
    const id = task.agentId;
    if (this.store.optedOut(id) || this.permissions.has(id)) return null;
    if (task.unanswered >= s.maxUnansweredPings) return null;
    const cands: { at: number; reason: string }[] = [];
    const idle = this.idleSince.get(id);
    const last = Math.max(task.lastActivityAt, task.lastPingAt ?? 0);
    if (idle !== undefined && !this.running.has(id)) {
      if (!this.busyOrWaiting(id)) {
        let at = idle + s.idleGraceSeconds * 1000;
        if (task.unanswered > 0) at = Math.max(at, last + this.waitMs(task, s));
        cands.push({ at, reason: "it stopped without finishing" });
      }
    } else {
      cands.push({ at: last + this.waitMs(task, s), reason: "hang check" });
    }
    for (const e of this.childEvents(id, s)) {
      if (this.notified.get(e.agentId) !== e.since) cands.push({ at: e.at, reason: `subagent '${e.title ?? e.agentId}' needs it` });
    }
    return cands.sort((a, b) => a.at - b.at)[0] ?? null;
  }

  /** Re-attach observers after a restart. */
  resume(): void {
    for (const agentId of new Set(this.store.active().map((t) => t.agentId))) this.actions.watch(agentId);
  }

  finish(task: Task, state: Task["state"], result: string | null = null): void {
    task.state = state;
    task.result = result ?? task.result;
    task.endedAt = this.now();
    this.store.save();
    this.unwatchIfIdle(task.agentId);
    for (const child of this.store.children(task.agentId)) this.unwatchIfIdle(child);
  }

  note(task: Task, text: string): void {
    task.notes = [...task.notes, { at: this.now(), text }].slice(-5);
    this.markActive(task);
    this.store.save();
  }

  // ---- inputs from lifecycle and timeline ----

  /** Any activity of the agent other than warden's own prompt. */
  activity(agentId: string): void {
    this.lastActivity.set(agentId, this.now());
    for (const task of this.store.active(agentId)) this.markActive(task);
  }

  turnStarted(agentId: string): void {
    this.running.add(agentId);
    this.idleSince.delete(agentId);
    if (this.reactPending.delete(agentId)) this.reactRunning.add(agentId);
    else if (!this.reactRunning.has(agentId)) this.reactEnded.delete(agentId);
    this.activity(agentId);
  }

  turnEnded(agentId: string): void {
    this.running.delete(agentId);
    this.idleSince.set(agentId, this.now());
    if (this.reactRunning.delete(agentId)) this.reactEnded.add(agentId);
    this.activity(agentId);
  }

  permission(agentId: string, pending: boolean): void {
    if (pending) {
      this.permissions.add(agentId);
      this.permissionSince.set(agentId, this.now());
    } else {
      this.permissions.delete(agentId);
      this.permissionSince.delete(agentId);
      this.actedAt.set(agentId, this.now());
    }
    this.activity(agentId);
  }

  agentArchived(agentId: string): void {
    this.store.upsertAgent(agentId, { archived: true });
    this.actedAt.set(agentId, this.now());
    this.permissionSince.delete(agentId);
    this.lastActivity.delete(agentId);
    this.permissions.delete(agentId);
    this.running.delete(agentId);
    this.idleSince.delete(agentId);
    this.reactPending.delete(agentId);
    this.reactRunning.delete(agentId);
    this.reactEnded.delete(agentId);
    for (const task of this.store.active(agentId)) this.finish(task, "archived");
  }

  private markActive(task: Task): void {
    task.lastActivityAt = this.now();
    task.unanswered = 0;
    task.notifiedParent = false;
    if (task.state === "gave-up") task.state = "active";
  }

  // ---- evaluation ----

  private waitMs(task: Task, s: WardenSettings): number {
    const factor = Math.min(s.backoffFactor ** task.unanswered, s.maxBackoffIntervals);
    return this.effectiveMinutes(task, s) * 60_000 * factor;
  }

  /** The registered interval, clamped to the max setting. */
  private effectiveMinutes(task: { intervalMinutes: number }, s: WardenSettings | null = this.settings()): number {
    return s ? Math.min(task.intervalMinutes, s.maxIntervalMinutes) : task.intervalMinutes;
  }

  /** Backstop used when an agent registers without an interval. */
  defaultIntervalMinutes(): number {
    return this.settings()?.maxIntervalMinutes ?? 15;
  }

  private turnState(agentId: string): TaskView["turn"] {
    if (this.permissions.has(agentId)) return "waiting-permission";
    if (this.running.has(agentId)) return "running";
    return this.idleSince.has(agentId) ? "idle" : "unknown";
  }

  private quietMs(task: Task): number {
    return this.now() - Math.max(task.lastActivityAt, task.lastPingAt ?? 0);
  }

  /**
   * Evaluate every active task once. At most one prompt leaves per call, and none within
   * `globalGapSeconds` of the previous one, so a mass stall can never become a broadcast.
   */
  async tick(): Promise<void> {
    const s = this.settings();
    if (!s?.enabled || this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const task of this.store.active()) {
        if (task.until !== null && now >= task.until) this.finish(task, "expired");
      }
      let sent = false;
      const due = this.store
        .active()
        .filter((t) => !this.store.optedOut(t.agentId) && !this.permissions.has(t.agentId))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      if (now - this.lastSendAt < s.globalGapSeconds * 1000) return;
      for (const task of due) {
        if (await this.step(task, s)) {
          sent = true;
          break;
        }
      }
      if (!sent) await this.childStep(s);
    } finally {
      this.busy = false;
    }
  }

  private async step(task: Task, s: WardenSettings): Promise<boolean> {
    const parentId = this.store.agent(task.agentId)?.parentId ?? null;
    if (task.unanswered >= s.notifyParentAfterPings && !task.notifiedParent && parentId) {
      task.notifiedParent = true;
      this.store.save();
      await this.deliver(parentId, render(s.parentTemplate, this.vars(task)));
      return true;
    }
    const idle = this.idleSince.get(task.agentId);
    const idleAgent = idle !== undefined && !this.running.has(task.agentId);
    if (idleAgent) {
      // Turn over, task still open: ping after the grace period, then back off like any other ping.
      if (this.busyOrWaiting(task.agentId) || this.now() - idle < s.idleGraceSeconds * 1000) return false;
      if (task.unanswered > 0 && this.quietMs(task) < this.waitMs(task, s)) return false;
    } else if (this.quietMs(task) < this.waitMs(task, s)) return false;
    if (task.unanswered >= s.maxUnansweredPings) {
      task.state = "gave-up";
      this.store.save();
      return false;
    }
    task.unanswered += 1;
    task.pings += 1;
    task.lastPingAt = this.now();
    this.store.save();
    await this.deliver(task.agentId, render(idleAgent ? s.idlePingTemplate : s.pingTemplate, this.vars(task)));
    return true;
  }

  private async deliver(agentId: string, text: string): Promise<void> {
    this.lastSendAt = this.now();
    this.ownSendAt.set(agentId, this.now());
    try {
      await this.actions.send(agentId, text);
    } catch (error) {
      console.error(`warden: prompt to ${agentId} failed`, error);
    }
  }

  /** Send a message to an agent on behalf of the user's `/warden` command. */
  async notify(agentId: string, text: string): Promise<void> {
    this.ownSendAt.set(agentId, this.now());
    await this.actions.send(agentId, text);
  }

  private vars(task: Task): Record<string, string | number> {
    const agent = this.store.agent(task.agentId);
    return {
      task: task.task,
      taskId: task.id,
      agentId: task.agentId,
      title: agent?.title ?? task.agentId,
      pings: task.pings,
      minutes: Math.max(1, Math.round((this.now() - (this.idleSince.get(task.agentId) ?? task.lastActivityAt)) / 60_000)),
    };
  }

  // ---- screen ----

  status(task: Task): TaskStatus {
    if (task.state !== "active") return task.state;
    if (this.permissions.has(task.agentId)) return "waiting-permission";
    if (task.notifiedParent) return "escalated";
    return task.unanswered > 0 ? "pinged" : "ok";
  }

  views(): TaskView[] {
    const s = this.settings();
    return this.store.all().map((t) => {
      const agent = this.store.agent(t.agentId);
      return {
        id: t.id,
        agentId: t.agentId,
        agentTitle: agent?.title ?? null,
        parentId: agent?.parentId ?? null,
        workspaceId: agent?.workspaceId ?? null,
        projectName: agent?.projectName ?? null,
        workspaceName: agent?.workspaceName ?? null,
        task: t.task,
        intervalMinutes: this.effectiveMinutes(t),
        turn: this.turnState(t.agentId),
        idleSince: this.idleSince.get(t.agentId) ?? null,
        until: t.until,
        registeredBy: t.registeredBy,
        source: t.source,
        status: this.status(t),
        createdAt: t.createdAt,
        lastActivityAt: t.lastActivityAt,
        lastPingAt: t.lastPingAt,
        pings: t.pings,
        unanswered: t.unanswered,
        notes: t.notes,
        result: t.result,
        children: this.store.children(t.agentId).length,
        needAttention: t.state === "active" && s ? this.attention(t.agentId, s).length : 0,
        nextPing: this.nextPing(t, s),
        waitingOn: agent?.waitingOn ?? null,
      };
    });
  }
}
