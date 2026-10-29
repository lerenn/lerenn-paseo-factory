import type { z } from "zod";
import type { FactoryHost, Paseo } from "./host";
import type { HostTool } from "./tools";

/** The outcome of an extension stage kind: the verdict picks the next stage like any other. */
export interface StageOutcome {
  verdict: string;
  summary?: string;
  data?: Record<string, unknown>;
}

/** What a stage kind of an extension sees. Stage kinds must be idempotent: after a daemon restart a running stage runs again. */
export interface StageKindContext {
  runId: string;
  stageId: string;
  blueprint: string;
  /** The stage's own fields from the blueprint file, templates already rendered. */
  params: Record<string, unknown>;
  vars: Record<string, string>;
  paseo: Paseo;
  services: FactoryServices;
  signal: AbortSignal;
}

export interface ExtensionStageKind {
  kind: string;
  run(ctx: StageKindContext): Promise<StageOutcome>;
}

export interface ExtensionRegistration {
  /** Lowercase id; also the owner of the tools (switching the extension off hides them). */
  id: string;
  version: string;
  /** Title of the Factory tab; omit for no tab. The extension never gets a sidebar row of its own. */
  tab?: string;
  tools: Omit<HostTool, "owner">[];
  stageKinds?: ExtensionStageKind[];
  /** Backend calls for the extension's tab, reached through `factory.extension.call`. Cheap and side-effect-safe to poll. */
  rpc?: ExtensionRpc[];
  /** Role definitions the extension ships (YAML text by name), offered next to the git ones. */
  roles?: { name: string; yaml: string }[];
  settingsSchema?: z.ZodType;
}

export interface ExtensionRpc {
  /** Lowercase letters, digits, '-' and '_' like tool names. */
  name: string;
  /**
   * Safe for other plugins to read: no side effect, no secret in the output. Only read-only rpcs are reachable over the
   * Factory's loopback endpoint (`POST /extensions/<id>/rpc/<name>`, bearer = endpoint token), so one extension can read another's facts.
   */
  readOnly?: boolean;
  input: z.ZodType;
  output: z.ZodType;
  run(input: any, call: { callerId: string }): Promise<unknown> | unknown;
}

export interface Extension extends Omit<ExtensionRegistration, "tab" | "stageKinds" | "roles" | "rpc"> {
  rpc: ExtensionRpc[];
  tab: string | null;
  stageKinds: ExtensionStageKind[];
  roles: { name: string; yaml: string }[];
}

/** The Factory's other modules, as extensions use them (`ctx.spawn`, `ctx.leases`, `ctx.warden`, `ctx.inbox`). */
export interface FactoryServices {
  spawn(options: SpawnOptions): Promise<{ agentId: string }>;
  leases: {
    acquire(agentId: string, name: string, ttlSeconds: number, mode: "queue" | "takeover"): unknown;
    renew(agentId: string, name: string, token: number, ttlSeconds?: number): unknown;
    release(agentId: string, name: string, token?: number): unknown;
    list(): unknown;
  };
  warden: {
    register(input: { agentId: string; task: string; intervalMinutes?: number; registeredBy: string }): { taskId: string };
    done(taskId: string, result: string): void;
  };
  inbox: {
    ask(input: { agentId: string; question: string; kind?: "question" | "approval"; context?: string; dedupeKey?: string }): { itemId: string };
    withdraw(itemId: string, reason?: string): void;
    status(itemId: string): { status: string; answer: string | null } | null;
  };
}

export interface SpawnOptions {
  role?: string;
  prompt: string;
  title?: string;
  cwd?: string;
  parent?: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
}

const PENDING = Symbol.for("paseo.factory.pending");

/**
 * Another plugin may load before the Factory. It pushes its registration to a queue on `globalThis`
 * (`Symbol.for("paseo.factory.pending")`) and the Factory drains it when it starts.
 */
export function registerWithHost(g: Record<symbol, unknown>, host: FactoryHost): void {
  const found = g[PENDING];
  const queue = Array.isArray(found) ? (found as ExtensionRegistration[]) : [];
  g[PENDING] = { push: (reg: ExtensionRegistration) => host.registerExtension(reg) };
  for (const reg of queue) {
    try {
      host.registerExtension(reg);
    } catch (error) {
      console.error(`factory: extension "${reg.id}" refused`, error);
    }
  }
}
