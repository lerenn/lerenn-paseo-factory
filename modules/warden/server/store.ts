import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const defaultStatePath = null as string | null;

export type TaskState = "active" | "done" | "expired" | "archived" | "cancelled" | "gave-up";

export interface Task {
  id: string;
  agentId: string;
  task: string;
  intervalMinutes: number;
  until: number | null;
  /** Agent id that registered it. */
  registeredBy: string;
  source: "agent" | "parent" | "announced-work" | "user";
  state: TaskState;
  createdAt: number;
  /** Last timeline activity of the agent, other than warden's own prompts. */
  lastActivityAt: number;
  lastPingAt: number | null;
  pings: number;
  /** Pings since the agent last did anything. */
  unanswered: number;
  notifiedParent: boolean;
  notes: { at: number; text: string }[];
  result: string | null;
  endedAt: number | null;
}

export interface KnownAgent {
  title: string | null;
  parentId: string | null;
  workspaceId: string | null;
  /** Display names, resolved once and kept so archived agents still show them. */
  projectName: string | null;
  workspaceName: string | null;
  /** Default ping interval from PASEO_WARDEN_INTERVAL at creation, in minutes. */
  defaultIntervalMinutes: number | null;
  /** Created with PASEO_WARDEN=off. */
  optOut: boolean;
  archived: boolean;
  /** Set via warden_update: what the agent is waiting on; suppresses idle attention until cleared. */
  waitingOn?: string | null;
}

/** The pre-unification `/warden supervise` record; migrated to a normal task on load. */
interface LegacySupervision {
  agentId: string;
  createdAt: number;
  pings?: number;
  unanswered?: number;
}

export const SUPERVISE_TASK = "Supervising child agents";

interface Session {
  agentId?: string;
  createdAt: number;
}

interface State {
  sessions: Record<string, Session>;
  agents: Record<string, KnownAgent>;
  tasks: Task[];
}

const UNBOUND_TTL_MS = 7 * 24 * 3600 * 1000;
const ENDED_TTL_MS = 7 * 24 * 3600 * 1000;

/** Capability tokens, known agents and tasks, persisted so a daemon restart loses nothing. */
export class Store {
  private state: State;

  constructor(private readonly file: string | null = defaultStatePath) {
    this.state = this.load();
    this.prune();
  }

  private load(): State {
    if (!this.file) return { sessions: {}, agents: {}, tasks: [] };
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      const tasks: Task[] = s.tasks ?? [];
      for (const sup of (s.supervisions ?? []) as LegacySupervision[]) {
        tasks.push({
          id: randomUUID().slice(0, 8),
          agentId: sup.agentId,
          task: SUPERVISE_TASK,
          intervalMinutes: 15,
          until: null,
          registeredBy: "user",
          source: "user",
          state: "active",
          createdAt: sup.createdAt,
          lastActivityAt: Date.now(),
          lastPingAt: null,
          pings: sup.pings ?? 0,
          unanswered: sup.unanswered ?? 0,
          notifiedParent: false,
          notes: [],
          result: null,
          endedAt: null,
        });
      }
      return { sessions: s.sessions ?? {}, agents: s.agents ?? {}, tasks };
    } catch {
      return { sessions: {}, agents: {}, tasks: [] };
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

  private prune(now = Date.now()): void {
    for (const [token, s] of Object.entries(this.state.sessions)) {
      if (!s.agentId && now - s.createdAt > UNBOUND_TTL_MS) delete this.state.sessions[token];
    }
    this.state.tasks = this.state.tasks.filter((t) => t.state === "active" || now - (t.endedAt ?? now) < ENDED_TTL_MS);
  }

  // ---- sessions ----

  createSession(): string {
    const token = randomBytes(24).toString("base64url");
    this.state.sessions[token] = { createdAt: Date.now() };
    this.save();
    return token;
  }

  resolve(token: string | undefined): Session | null {
    if (!token) return null;
    const candidate = Buffer.from(token);
    let found: Session | null = null;
    for (const [known, session] of Object.entries(this.state.sessions)) {
      const k = Buffer.from(known);
      if (k.length === candidate.length && timingSafeEqual(k, candidate)) found = session;
    }
    return found;
  }

  bind(token: string, agentId: string): boolean {
    const session = this.state.sessions[token];
    if (!session) return false;
    session.agentId = agentId;
    this.save();
    return true;
  }

  forgetAgentSessions(agentId: string): void {
    for (const [token, s] of Object.entries(this.state.sessions)) if (s.agentId === agentId) delete this.state.sessions[token];
    this.save();
  }

  // ---- agents ----

  agent(id: string): KnownAgent | undefined {
    return this.state.agents[id];
  }

  upsertAgent(id: string, patch: Partial<KnownAgent>): KnownAgent {
    const cur = this.state.agents[id] ?? { title: null, parentId: null, workspaceId: null, projectName: null, workspaceName: null, defaultIntervalMinutes: null, optOut: false, archived: false };
    const next: KnownAgent = {
      title: patch.title ?? cur.title,
      parentId: patch.parentId ?? cur.parentId,
      workspaceId: patch.workspaceId ?? cur.workspaceId,
      defaultIntervalMinutes: patch.defaultIntervalMinutes ?? cur.defaultIntervalMinutes ?? null,
      projectName: patch.projectName ?? cur.projectName ?? null,
      workspaceName: patch.workspaceName ?? cur.workspaceName ?? null,
      optOut: patch.optOut ?? cur.optOut,
      archived: patch.archived ?? cur.archived ?? false,
    };
    this.state.agents[id] = next;
    this.save();
    return next;
  }

  setWaiting(id: string, reason: string | null): void {
    const agent = this.state.agents[id];
    if (!agent || (agent.waitingOn ?? null) === reason) return;
    agent.waitingOn = reason;
    this.save();
  }

  /** True when `ancestor` is `agentId`'s parent, or the parent of its parent, and so on. */
  isAncestor(ancestor: string, agentId: string): boolean {
    const seen = new Set<string>();
    for (let cur = this.state.agents[agentId]?.parentId; cur && !seen.has(cur); cur = this.state.agents[cur]?.parentId) {
      if (cur === ancestor) return true;
      seen.add(cur);
    }
    return false;
  }

  /** The agent or one of its ancestors was created with PASEO_WARDEN=off. */
  optedOut(agentId: string): boolean {
    const seen = new Set<string>();
    for (let cur: string | null | undefined = agentId; cur && !seen.has(cur); cur = this.state.agents[cur]?.parentId) {
      if (this.state.agents[cur]?.optOut) return true;
      seen.add(cur);
    }
    return false;
  }

  /** Direct, non-archived children warden has seen. */
  children(parentId: string): string[] {
    return Object.entries(this.state.agents)
      .filter(([, a]) => a.parentId === parentId && !a.archived)
      .map(([id]) => id);
  }

  // ---- tasks ----

  add(input: Pick<Task, "agentId" | "task" | "intervalMinutes" | "until" | "registeredBy" | "source">, now: number): Task {
    const task: Task = {
      ...input,
      id: randomUUID().slice(0, 8),
      state: "active",
      createdAt: now,
      lastActivityAt: now,
      lastPingAt: null,
      pings: 0,
      unanswered: 0,
      notifiedParent: false,
      notes: [],
      result: null,
      endedAt: null,
    };
    this.state.tasks.push(task);
    this.save();
    return task;
  }

  get(id: string): Task | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  all(): Task[] {
    return this.state.tasks;
  }

  active(agentId?: string): Task[] {
    return this.state.tasks.filter((t) => t.state === "active" && (agentId === undefined || t.agentId === agentId));
  }
}
