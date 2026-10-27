import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SupervisorRequest } from "../../shared/supervisor/rpc";

interface State {
  agentId: string | null;
  startedAt: number | null;
  /** How many times the agent was created (idempotency key of the creation). */
  generation: number;
  restarts: { extension: string; at: number }[];
  requests: SupervisorRequest[];
  /** issue key -> last time it was told to the Supervisor */
  told: Record<string, number>;
  /** The workspace (pod) of the current agent, archived with it. */
  workspaceId: string | null;
  /** Notes kept by the Supervisor (supervisor_note) across sessions, capped at MAX_MEMORY bytes. */
  memory: string;
  /** Number of the current or last session. */
  lastIncarnation: number;
  incarnations: Incarnation[];
  /** When the agent was archived for being idle (null while one runs). */
  archivedAt: number | null;
  /** Digests waiting for the agent to wake. */
  pendingDigests: { subject: string; body: string }[];
  /** Messages from the user (Supervisor tab) waiting for the agent to wake. */
  outbox: string[];
  /** Problems seen while the agent was archived that did not wake it. */
  flags: { key: string; text: string; at: number }[];
}

export interface Incarnation {
  n: number;
  agentId: string;
  workspaceId: string | null;
  startedAt: number;
  endedAt: number | null;
  reason: string | null;
}

const MAX_REQUESTS = 200;
export const MAX_INCARNATIONS = 20;
export const MAX_MEMORY = 8 * 1024;

/** Append a note and keep the newest MAX_MEMORY bytes, cutting at a note start. */
export function appendMemory(memory: string, text: string, at: number): string {
  const next = `${memory}${memory && !memory.endsWith("\n") ? "\n" : ""}- ${new Date(at).toISOString().slice(0, 16)}Z ${text.trim().replace(/\n+/g, "\n  ")}\n`;
  let cut = next;
  while (Buffer.byteLength(cut) > MAX_MEMORY) {
    const nl = cut.indexOf("\n- ", 1);
    if (nl === -1) return cut.slice(-MAX_MEMORY);
    cut = cut.slice(nl + 1);
  }
  return cut;
}

/** The Supervisor's id, requests, extension restarts and what it was already told, kept across restarts. */
export class SupervisorState {
  private state: State = { agentId: null, startedAt: null, generation: 0, restarts: [], requests: [], told: {}, workspaceId: null, memory: "", lastIncarnation: 0, incarnations: [], archivedAt: null, pendingDigests: [], outbox: [], flags: [] };

  constructor(private readonly file: string | null) {
    if (file) {
      try {
        this.state = { ...this.state, ...JSON.parse(readFileSync(file, "utf8")) };
      } catch {
        /* first run */
      }
    }
  }

  get data(): State {
    return this.state;
  }

  save(): void {
    if (!this.file) return;
    if (this.state.incarnations.length > MAX_INCARNATIONS) this.state.incarnations.splice(0, this.state.incarnations.length - MAX_INCARNATIONS);
    if (this.state.requests.length > MAX_REQUESTS) this.state.requests.splice(0, this.state.requests.length - MAX_REQUESTS);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

const HOUR = 3600_000;

/** One restart per extension per hour; a second one inside the hour is refused so a person decides. */
export function restartAllowed(restarts: readonly { extension: string; at: number }[], extension: string, now: number): { ok: true } | { ok: false; minutesAgo: number } {
  const last = restarts.filter((r) => r.extension === extension).sort((a, b) => b.at - a.at)[0];
  if (last && now - last.at < HOUR) return { ok: false, minutesAgo: Math.max(0, Math.round((now - last.at) / 60_000)) };
  return { ok: true };
}
