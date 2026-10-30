import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Agents Mail (plugin `agents-mail`) and Events (plugin `events`) give an agent their tools with these env variables. */
export const MAIL_CAPABILITY_ENV = "PASEO_AGENTS_MAIL_CAPABILITY";
export const EVENTS_CAPABILITY_ENV = "PASEO_EVENTS_CAPABILITY";

export const mailEndpointFile = () => process.env.FACTORY_MAIL_ENDPOINT ?? path.join(homedir(), ".paseo", "agents-mail", "endpoint.json");

export interface MailEndpoint {
  url: string;
  token: string;
}

/** What an agent was given when its session opened: true / false, or null when the Factory has not seen its session. */
export interface AgentCapabilities {
  mail: boolean | null;
  events: boolean | null;
}

interface Options {
  mailFile?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a health result (up or down) is reused. */
  ttlMs?: number;
}

/**
 * Which satellite plugins are there, found at runtime with no import (the Factory works without any of them):
 * - Agents Mail, for the Factory itself: `~/.paseo/agents-mail/endpoint.json` exists and `/api/health` answers;
 * - Agents Mail and Events, for one agent: the env variables they put on it when its session opened.
 */
export class Capabilities {
  private readonly file: () => string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly ttl: number;
  private cached: { at: number; endpoint: MailEndpoint | null } | null = null;
  private probing: Promise<MailEndpoint | null> | null = null;
  private readonly agents = new Map<string, AgentCapabilities>();
  private lastEvents: boolean | null = null;

  constructor(opts: Options = {}) {
    this.file = opts.mailFile ?? mailEndpointFile;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttl = opts.ttlMs ?? 60_000;
  }

  /** The Agents Mail endpoint when it is installed and answering (health reused for `ttlMs`), else null. */
  mailEndpoint(): Promise<MailEndpoint | null> {
    if (this.cached && this.now() - this.cached.at < this.ttl) return Promise.resolve(this.cached.endpoint);
    this.probing ??= this.probe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async probe(): Promise<MailEndpoint | null> {
    let found: MailEndpoint | null = null;
    try {
      const raw = JSON.parse(readFileSync(this.file(), "utf8")) as { url?: string; token?: string };
      if (raw.url && raw.token) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 2000);
        const res = await this.doFetch(`${raw.url.replace(/\/$/, "")}/api/health`, { headers: { authorization: `Bearer ${raw.token}` }, signal: abort.signal as never }).finally(() => clearTimeout(timer));
        if (res.ok) found = { url: raw.url.replace(/\/$/, ""), token: raw.token };
      }
    } catch {
      found = null;
    }
    this.cached = { at: this.now(), endpoint: found };
    return found;
  }

  /** A mail failed: take Agents Mail as down for `ttlMs`. */
  markMailDown(): void {
    this.cached = { at: this.now(), endpoint: null };
  }

  /**
   * Agents Mail as last seen, without waiting (for synchronous decisions); a stale result is refreshed in the background.
   * False until the first probe answered: call `mailEndpoint()` once at start.
   */
  mail(): boolean {
    if (!this.cached || this.now() - this.cached.at >= this.ttl) void this.mailEndpoint();
    return !!this.cached?.endpoint;
  }

  /** An agent's session opened with this env. */
  noteSession(agentId: string, env: Record<string, string | undefined>): void {
    const caps = { mail: !!env[MAIL_CAPABILITY_ENV], events: !!env[EVENTS_CAPABILITY_ENV] };
    this.agents.set(agentId, caps);
    this.lastEvents = caps.events;
  }

  forget(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** The tools an agent really has, as its session showed; null for a plugin when the session was not seen. */
  agent(agentId: string): AgentCapabilities {
    return this.agents.get(agentId) ?? { mail: null, events: null };
  }

  /** Events, as the last session the Factory saw open showed it (null: none seen yet). */
  events(): boolean | null {
    return this.lastEvents;
  }
}
