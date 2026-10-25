import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Answer, InboxOption, ItemStatus } from "../shared/item";

export const defaultStatePath = null as string | null;

export interface Item {
  id: string;
  agentId: string;
  kind: "question" | "approval";
  question: string;
  context: string | null;
  options: InboxOption[];
  allowFreeText: boolean;
  blocking: boolean;
  dedupeKey: string;
  status: ItemStatus;
  createdAt: number;
  expiresAt: number | null;
  defaultOptionId: string | null;
  defaultText: string | null;
  /** Asked by the Factory itself (blueprint gate): never messaged back. */
  internal?: boolean;
  readAt: number | null;
  answer: Answer | null;
  comment: string | null;
  /** Message owed to the asker: "answer" after an answer, "expired" after an expiry without default. */
  owed: "answer" | "expired" | null;
  delivery: "pending" | "sent" | "failed" | "undeliverable" | "none";
  deliveryAttempts: number;
  lastAttemptAt: number | null;
  endedAt: number | null;
}

export interface AuditEvent {
  at: number;
  itemId: string;
  type:
    | "asked"
    | "deduped"
    | "answered"
    | "answer_refused"
    | "expired"
    | "withdrawn"
    | "archived"
    | "delivered"
    | "delivery_failed"
    | "undeliverable"
    | "read";
  actor: string;
  detail: string | null;
}

export interface KnownAgent {
  title: string | null;
  workspaceId: string | null;
  projectName: string | null;
  workspaceName: string | null;
  /** Created with PASEO_INBOX=off. */
  optOut: boolean;
}

interface Session {
  agentId?: string;
  createdAt: number;
}

interface State {
  sessions: Record<string, Session>;
  agents: Record<string, KnownAgent>;
  items: Item[];
  events: AuditEvent[];
}

const UNBOUND_TTL_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_EVENTS = 5000;

const empty = (): State => ({ sessions: {}, agents: {}, items: [], events: [] });

/** Capability tokens, known agents, items and the audit log, persisted so a daemon restart loses nothing. */
export class Store {
  private state: State;

  constructor(
    private readonly file: string | null = defaultStatePath,
    retentionDays = 30,
  ) {
    this.state = this.load();
    this.prune(Date.now(), retentionDays);
  }

  private load(): State {
    if (!this.file) return empty();
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      return { sessions: s.sessions ?? {}, agents: s.agents ?? {}, items: s.items ?? [], events: s.events ?? [] };
    } catch {
      return empty();
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

  prune(now: number, retentionDays: number): void {
    for (const [token, s] of Object.entries(this.state.sessions)) {
      if (!s.agentId && now - s.createdAt > UNBOUND_TTL_MS) delete this.state.sessions[token];
    }
    const cutoff = now - retentionDays * DAY_MS;
    this.state.items = this.state.items.filter((i) => i.status === "pending" || i.delivery === "pending" || (i.endedAt ?? now) > cutoff);
    const kept = new Set(this.state.items.map((i) => i.id));
    this.state.events = this.state.events.filter((e) => e.at > cutoff && kept.has(e.itemId)).slice(-MAX_EVENTS);
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
    const cur = this.state.agents[id] ?? { title: null, workspaceId: null, projectName: null, workspaceName: null, optOut: false };
    const next: KnownAgent = {
      title: patch.title ?? cur.title,
      workspaceId: patch.workspaceId ?? cur.workspaceId,
      projectName: patch.projectName ?? cur.projectName,
      workspaceName: patch.workspaceName ?? cur.workspaceName,
      optOut: patch.optOut ?? cur.optOut,
    };
    this.state.agents[id] = next;
    this.save();
    return next;
  }

  // ---- items ----

  add(input: Omit<Item, "id" | "status" | "createdAt" | "readAt" | "answer" | "comment" | "owed" | "delivery" | "deliveryAttempts" | "lastAttemptAt" | "endedAt">, now: number): Item {
    const item: Item = {
      ...input,
      id: randomUUID().slice(0, 8),
      status: "pending",
      createdAt: now,
      readAt: null,
      answer: null,
      comment: null,
      owed: null,
      delivery: "none",
      deliveryAttempts: 0,
      lastAttemptAt: null,
      endedAt: null,
    };
    this.state.items.push(item);
    this.save();
    return item;
  }

  get(id: string): Item | undefined {
    return this.state.items.find((i) => i.id === id);
  }

  all(): Item[] {
    return this.state.items;
  }

  pending(agentId?: string): Item[] {
    return this.state.items.filter((i) => i.status === "pending" && (agentId === undefined || i.agentId === agentId));
  }

  /** The live item of this agent with this key, if any: asking again is idempotent. */
  live(agentId: string, dedupeKey: string): Item | undefined {
    return this.state.items.find((i) => i.agentId === agentId && i.dedupeKey === dedupeKey && i.status === "pending");
  }

  // ---- audit ----

  log(event: Omit<AuditEvent, "at">, now = Date.now()): void {
    this.state.events.push({ ...event, at: now });
    if (this.state.events.length > MAX_EVENTS * 2) this.state.events = this.state.events.slice(-MAX_EVENTS);
  }

  events(): AuditEvent[] {
    return this.state.events;
  }
}
