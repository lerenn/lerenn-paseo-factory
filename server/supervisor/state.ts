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
}

const MAX_REQUESTS = 200;

/** The Supervisor's id, requests, extension restarts and what it was already told, kept across restarts. */
export class SupervisorState {
  private state: State = { agentId: null, startedAt: null, generation: 0, restarts: [], requests: [], told: {} };

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
