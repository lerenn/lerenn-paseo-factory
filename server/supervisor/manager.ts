import { randomBytes } from "node:crypto";
import type { SupervisorRequest, SupervisorStatus } from "../../shared/supervisor/rpc";
import type { SupervisorSettings } from "../../shared/supervisor/settings";
import type { Issue } from "../host";
import { digestMessage, nextDigest } from "./digest";
import { restartAllowed, type SupervisorState } from "./state";

export const SUPERVISOR_LABEL = "paseo.factory.supervisor";

export interface SupervisorPorts {
  now(): number;
  /** Create the agent on the daemon; resolves with its id. */
  create(o: { idempotencyKey: string; prompt: string; cwd: string }): Promise<string>;
  send(agentId: string, text: string): Promise<void>;
  agentState(agentId: string): Promise<"running" | "idle" | "gone">;
  issues(): Promise<Issue[]>;
  nameOf(agentId: string): Promise<string>;
  restartExtension(id: string): Promise<string>;
  settings(): SupervisorSettings;
  defaultCwd(): string | undefined;
}

const INTRO =
  "You are the Factory Supervisor, the one persistent agent that watches the Factory itself. The Factory sends you digests of problems " +
  "(stuck or failed runs with no PM, spawn failures, lease contention, extension health, config errors) and requests from other agents " +
  "(\"Supervisor request <id> from <name>\": answer with supervisor_reply). Follow your role file.";

/** The one Supervisor agent: keeps it alive, tells it what is wrong, relays requests from other agents. */
export class Supervisor {
  private readonly waiters = new Map<string, (answer: string) => void>();
  private starting: Promise<void> | null = null;
  error: string | null = null;
  lastDigestAt: number | null = null;
  private lastIssues: Issue[] = [];

  constructor(
    readonly state: SupervisorState,
    private readonly ports: SupervisorPorts,
  ) {}

  // ---- lifecycle ----

  /** Create the agent when there is none or it is gone. `restart` replaces a live one. */
  ensure(opts: { restart?: boolean } = {}): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doEnsure(opts).finally(() => (this.starting = null));
    return this.starting;
  }

  private async doEnsure(opts: { restart?: boolean }): Promise<void> {
    const data = this.state.data;
    if (data.agentId && !opts.restart && (await this.ports.agentState(data.agentId)) !== "gone") {
      this.error = null;
      return;
    }
    const cwd = this.ports.settings().cwd ?? this.ports.defaultCwd();
    if (!cwd) {
      this.error = "No working directory: set the Supervisor setting cwd (or FACTORY_DEFAULT_CWD).";
      return;
    }
    try {
      data.generation += 1;
      this.state.save();
      const id = await this.ports.create({ idempotencyKey: `supervisor:${data.generation}`, prompt: INTRO, cwd });
      data.agentId = id;
      data.startedAt = this.ports.now();
      this.error = null;
      this.state.save();
    } catch (error) {
      this.error = `could not start the Supervisor: ${(error as Error).message}`;
    }
  }

  async status(): Promise<SupervisorStatus> {
    const data = this.state.data;
    const live = data.agentId ? await this.ports.agentState(data.agentId) : null;
    return {
      agentId: data.agentId,
      state: this.error ? "error" : !data.agentId ? "not-started" : live === "running" ? "running" : live === "idle" ? "idle" : "stopped",
      error: this.error,
      startedAt: data.startedAt,
      issues: this.lastIssues,
      lastDigestAt: this.lastDigestAt,
      restarts: data.restarts.slice(-20),
      requests: data.requests.slice(-30),
    };
  }

  // ---- digest ----

  /** Look for problems and tell the Supervisor about new ones. */
  async digest(): Promise<void> {
    const settings = this.ports.settings();
    this.lastIssues = await this.ports.issues();
    const data = this.state.data;
    const { send, told } = nextDigest(this.lastIssues, data.told, this.ports.now(), settings.repeatMinutes * 60_000);
    if (send.length === 0) {
      if (Object.keys(told).length !== Object.keys(data.told).length) {
        data.told = told;
        this.state.save();
      }
      return;
    }
    if (!data.agentId || (await this.ports.agentState(data.agentId)) === "gone") {
      if (settings.autoStart) await this.ensure();
      if (!data.agentId) return;
    }
    try {
      await this.ports.send(data.agentId, digestMessage(send));
      data.told = told;
      this.lastDigestAt = this.ports.now();
      this.state.save();
    } catch (error) {
      this.error = `could not reach the Supervisor: ${(error as Error).message}`;
    }
  }

  // ---- requests from other agents ----

  /** supervisor_ask: relay a question, wait for supervisor_reply, or return the pending request. */
  async ask(from: { id: string; name: string }, question: string): Promise<{ status: "answered"; request: string; answer: string } | { status: "pending"; request: string; note: string }> {
    await this.ensure();
    const data = this.state.data;
    if (!data.agentId) throw new Error(this.error ?? "The Supervisor is not running.");
    const request: SupervisorRequest = { id: `sq-${randomBytes(3).toString("hex")}`, fromId: from.id, fromName: from.name, question, at: this.ports.now(), answer: null, answeredAt: null };
    data.requests.push(request);
    this.state.save();
    const answered = new Promise<string>((resolve) => this.waiters.set(request.id, resolve));
    await this.ports.send(data.agentId, `Supervisor request ${request.id} from "${from.name}" (${from.id}): ${question}\nAnswer with supervisor_reply(request="${request.id}", answer="...").`);
    const timeoutMs = this.ports.settings().askTimeoutSeconds * 1000;
    const winner = await Promise.race([answered, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    this.waiters.delete(request.id);
    if (winner !== null) return { status: "answered", request: request.id, answer: winner };
    return { status: "pending", request: request.id, note: "The Supervisor has not answered yet; poll supervisor_ask_status with this request id." };
  }

  request(id: string): SupervisorRequest | undefined {
    return this.state.data.requests.find((r) => r.id === id);
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

  /** At most once an hour per extension; a second request inside the hour tells the Supervisor to ask Louis. */
  async restartExtension(id: string): Promise<string> {
    const now = this.ports.now();
    const allowed = restartAllowed(this.state.data.restarts, id, now);
    if (!allowed.ok) {
      throw new Error(`Extension ${id} was already restarted ${allowed.minutesAgo} min ago (limit: once per hour). Ask Louis through inbox_ask what to do.`);
    }
    this.state.data.restarts.push({ extension: id, at: now });
    this.state.save();
    return this.ports.restartExtension(id);
  }
}
