import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Session {
  agentId?: string;
  createdAt: number;
}

const UNBOUND_TTL_MS = 7 * 24 * 3600 * 1000;

/** Capability tokens of the `factory` MCP server: one per created agent, bound to its id when the session opens. */
export class SessionStore {
  private sessions: Record<string, Session> = {};

  constructor(private readonly file: string | null) {
    if (file) {
      try {
        this.sessions = JSON.parse(readFileSync(file, "utf8")).sessions ?? {};
      } catch {
        this.sessions = {};
      }
    }
    const now = Date.now();
    for (const [token, s] of Object.entries(this.sessions)) if (!s.agentId && now - s.createdAt > UNBOUND_TTL_MS) delete this.sessions[token];
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: this.sessions }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  create(): string {
    const token = randomBytes(24).toString("base64url");
    this.sessions[token] = { createdAt: Date.now() };
    this.save();
    return token;
  }

  resolve(token: string | undefined): Session | null {
    if (!token) return null;
    const candidate = Buffer.from(token);
    let found: Session | null = null;
    for (const [known, session] of Object.entries(this.sessions)) {
      const k = Buffer.from(known);
      if (k.length === candidate.length && timingSafeEqual(k, candidate)) found = session;
    }
    return found;
  }

  bind(token: string, agentId: string): boolean {
    const session = this.sessions[token];
    if (!session) return false;
    session.agentId = agentId;
    this.save();
    return true;
  }

  forgetAgent(agentId: string): void {
    for (const [token, s] of Object.entries(this.sessions)) if (s.agentId === agentId) delete this.sessions[token];
    this.save();
  }
}
