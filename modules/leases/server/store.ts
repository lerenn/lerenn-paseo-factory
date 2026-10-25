import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { LeaseMode } from "../shared/lease";

export const defaultStatePath = path.join(homedir(), ".paseo", "plugin-data", "agents-leases", "state.json");

export interface Holder {
  agentId: string;
  mode: LeaseMode;
  ttlSeconds: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface Waiter {
  agentId: string;
  ttlSeconds: number;
  enqueuedAt: number;
}

export interface Lease {
  name: string;
  /** Fencing token. Goes up on every change of holder and never goes down, even while the lease is free. */
  handover: number;
  holder: Holder | null;
  queue: Waiter[];
  updatedAt: number;
}

/** A message owed to an agent: it is stored first and delivered with retries, so a restart loses none. */
export interface Outgoing {
  id: string;
  agentId: string;
  lease: string;
  kind: "granted" | "lost";
  text: string;
  status: "pending" | "sent" | "failed" | "undeliverable";
  attempts: number;
  lastAttemptAt: number | null;
  createdAt: number;
}

export interface AuditEvent {
  at: number;
  lease: string;
  type:
    | "acquired"
    | "renewed"
    | "queued"
    | "dequeued"
    | "granted"
    | "taken_over"
    | "released"
    | "force_released"
    | "expired"
    | "archived"
    | "refused"
    | "delivered"
    | "delivery_failed"
    | "undeliverable";
  actor: string;
  detail: string | null;
}

export interface KnownAgent {
  title: string | null;
  workspaceId: string | null;
  /** Created with PASEO_LEASES=off. */
  optOut: boolean;
}

interface Session {
  agentId?: string;
  createdAt: number;
}

interface State {
  sessions: Record<string, Session>;
  agents: Record<string, KnownAgent>;
  leases: Record<string, Lease>;
  outbox: Outgoing[];
  events: AuditEvent[];
}

const UNBOUND_TTL_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_EVENTS = 5000;

const empty = (): State => ({ sessions: {}, agents: {}, leases: {}, outbox: [], events: [] });

/** Capability tokens, known agents, leases, owed messages and the audit log, persisted so a daemon restart loses nothing. */
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
      return { sessions: s.sessions ?? {}, agents: s.agents ?? {}, leases: s.leases ?? {}, outbox: s.outbox ?? [], events: s.events ?? [] };
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
    for (const [name, l] of Object.entries(this.state.leases)) {
      if (!l.holder && l.queue.length === 0 && l.updatedAt < cutoff) delete this.state.leases[name];
    }
    this.state.outbox = this.state.outbox.filter((m) => m.status === "pending" || m.createdAt > cutoff);
    this.state.events = this.state.events.filter((e) => e.at > cutoff).slice(-MAX_EVENTS);
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
    const cur = this.state.agents[id] ?? { title: null, workspaceId: null, optOut: false };
    const next: KnownAgent = {
      title: patch.title ?? cur.title,
      workspaceId: patch.workspaceId ?? cur.workspaceId,
      optOut: patch.optOut ?? cur.optOut,
    };
    this.state.agents[id] = next;
    this.save();
    return next;
  }

  // ---- leases ----

  lease(name: string): Lease | undefined {
    return this.state.leases[name];
  }

  /** The lease record, created free (handover 0) on first use. */
  ensureLease(name: string, now: number): Lease {
    return (this.state.leases[name] ??= { name, handover: 0, holder: null, queue: [], updatedAt: now });
  }

  leases(): Lease[] {
    return Object.values(this.state.leases);
  }

  // ---- outbox ----

  enqueue(input: Pick<Outgoing, "agentId" | "lease" | "kind" | "text">, now: number): Outgoing {
    const message: Outgoing = { ...input, id: randomUUID().slice(0, 8), status: "pending", attempts: 0, lastAttemptAt: null, createdAt: now };
    this.state.outbox.push(message);
    return message;
  }

  outbox(): Outgoing[] {
    return this.state.outbox;
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
