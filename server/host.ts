import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginBeforeRequests, PluginHookContext, PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { factorySettings, type FactorySettings, type ModuleId } from "../shared/settings";
import { McpServer } from "./mcp";
import { SessionStore } from "./sessions";
import type { CallContext, HostTool } from "./tools";
import type { Extension, ExtensionRegistration } from "./extensions";
import { registerWithHost } from "./extensions";
import { buildRemote, MAX_FAILURES, PendingOutcomes, probe, remoteRegistrationSchema, type RemoteHandle } from "./remote";

type CreateRequest = PluginBeforeRequests["agent.create"];
export type Paseo = PluginHookContext["paseo"];

export const SERVER_NAME = "factory";
export const CAPABILITY_ENV = "PASEO_FACTORY_CAPABILITY";
const DEFAULT_PORT = 47820;
const MAX_BODY = 1_000_000;

export const dataDir = () => process.env.FACTORY_DATA ?? path.join(homedir(), ".paseo", "plugin-data", "paseo-factory");
export const endpointFile = () => process.env.FACTORY_ENDPOINT ?? path.join(homedir(), ".paseo", "factory", "endpoint.json");

/** What a module adds to every agent it applies to. */
export interface Contribution {
  module: string;
  /** Prompt note appended to the agent's system prompt. */
  note: string;
  /** Tools to preapprove for this request, or null when the module does not apply to it. */
  tools(request: CreateRequest): string[] | null | Promise<string[] | null>;
}

/** The Blueprints module, as the HTTP endpoint for the Events plugin sees it. */
export interface BlueprintEndpoint {
  list(): { name: string; description: string; vars: { name: string; required: boolean; description: string }[] }[];
  start(input: { blueprint: string; vars: Record<string, string>; requestedBy: string; idempotencyKey?: string }): { runId: string };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type BeforeCreate = (request: CreateRequest, ctx: PluginHookContext) => CreateRequest | void | Promise<CreateRequest | void>;

/**
 * The one thing all modules share: the single loopback endpoint (the `factory` MCP server and the
 * blueprint start API), the capability sessions, the prompt/tool injection and the extension registry.
 */
export class FactoryHost {
  readonly sessions: SessionStore;
  private readonly tools = new Map<string, HostTool>();
  private readonly aliases = new Map<string, HostTool>();
  private readonly instructions = new Map<string, string>();
  private readonly contributions: Contribution[] = [];
  private readonly createHooks: BeforeCreate[] = [];
  private readonly extensions = new Map<string, Extension>();
  private readonly remotes = new Map<string, { handle: RemoteHandle; remove: () => void }>();
  private readonly pending = new PendingOutcomes();
  private readonly labelCache = new Map<string, { at: number; labels: Record<string, string> }>();
  private http: Server | null = null;
  private current: FactorySettings | null = null;
  private paseoRef: Paseo | null = null;
  private readonly endpointToken = randomBytes(24).toString("base64url");
  url: string | null = null;
  startError: string | null = null;
  blueprints: BlueprintEndpoint | null = null;
  /** Set by the Roles module: the git sources the Blueprints module reads its files from. */
  gitSources: { subDir(source: any, name: string): string } | null = null;
  configuredSources: () => Promise<unknown[]> = async () => [];
  readonly ready: Promise<void>;
  private started: Promise<void> = Promise.resolve();

  /** Resolves once the endpoint is listening (or failed to). */
  get listening(): Promise<void> {
    return this.started;
  }
  private unsubscribe: () => void;

  constructor(readonly server: PluginServerContext, opts: { sessionsFile?: string | null } = {}) {
    this.sessions = new SessionStore(opts.sessionsFile === undefined ? path.join(dataDir(), "sessions.json") : opts.sessionsFile);
    const settings = server.registerSettings(factorySettings);
    const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
      this.current = state.status === "ready" ? state.values : null;
    };
    this.ready = settings.read().then(apply);
    this.unsubscribe = settings.subscribe(apply);
    this.registerGlobal();
  }

  // ---- settings and modules ----

  get settings(): FactorySettings | null {
    return this.current;
  }

  /** A module that is not switched off. Before the settings are read, everything is on. */
  enabled(module: ModuleId | string): boolean {
    const modules = this.current?.modules as Record<string, boolean> | undefined;
    return modules?.[module] ?? true;
  }

  /** Path of a module's state file; with `importLegacyState` on, a missing one is seeded from the old plugin's file. */
  statePath(module: ModuleId, legacyName?: string): string {
    const file = path.join(dataDir(), `${module}.json`);
    if (this.current?.importLegacyState && legacyName && !existsSync(file)) {
      const old = path.join(homedir(), ".paseo", "plugin-data", legacyName, "state.json");
      if (existsSync(old)) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        copyFileSync(old, file);
        chmodSync(file, 0o600);
      }
    }
    return file;
  }

  // ---- the daemon SDK ----

  capture(ctx: { paseo: Paseo }): void {
    const first = this.paseoRef === null;
    this.paseoRef = ctx.paseo;
    if (first) for (const cb of this.paseoWaiters) cb(ctx.paseo);
  }

  private readonly paseoWaiters: ((paseo: Paseo) => void)[] = [];

  /** Run once the daemon-side SDK is known (the first hook or RPC). */
  whenPaseo(cb: (paseo: Paseo) => void): void {
    if (this.paseoRef) cb(this.paseoRef);
    else this.paseoWaiters.push(cb);
  }

  /** The other modules' engines, for the Blueprints module and extensions. */
  engines: { inbox?: any; leases?: any; warden?: any } = {};

  /** Call a tool of the Factory or of an extension as the Factory itself. */
  toolRunner(name: string): ((args: Record<string, unknown>) => Promise<unknown>) | null {
    const tool = this.tools.get(name);
    if (!tool || name.startsWith("blueprint_")) return null;
    return async (args) => {
      const parsed = tool.input.parse(args);
      return tool.run(parsed, { callerId: "factory", labels: async () => ({}) });
    };
  }

  get paseo(): Paseo {
    if (!this.paseoRef) throw new Error("Paseo API not available yet");
    return this.paseoRef;
  }

  hasPaseo(): boolean {
    return this.paseoRef !== null;
  }

  /** Labels of an agent (cached briefly): the `paseo.*` labels carry the factory run and the Assistant mark. */
  async labelsOf(agentId: string): Promise<Record<string, string>> {
    const cached = this.labelCache.get(agentId);
    if (cached && Date.now() - cached.at < 30_000) return cached.labels;
    let labels: Record<string, string> = {};
    try {
      const { entries } = await this.paseo.agents.list({ filter: { includeArchived: false } } as never);
      for (const { agent } of entries as { agent: { id: string; labels?: Record<string, string> } }[]) {
        this.labelCache.set(agent.id, { at: Date.now(), labels: agent.labels ?? {} });
        if (agent.id === agentId) labels = agent.labels ?? {};
      }
    } catch (error) {
      console.error("factory: label lookup failed", error);
    }
    return labels;
  }

  // ---- tools, notes, hooks ----

  registerTools(owner: string, tools: Omit<HostTool, "owner">[], aliases: Omit<HostTool, "owner">[] = []): () => void {
    for (const t of tools) this.tools.set(t.name, { ...t, owner });
    for (const t of aliases) this.aliases.set(t.name, { ...t, owner });
    return () => {
      for (const t of tools) this.tools.delete(t.name);
      for (const t of aliases) this.aliases.delete(t.name);
    };
  }

  setInstructions(owner: string, text: string): void {
    this.instructions.set(owner, text);
  }

  contribute(c: Contribution): void {
    this.contributions.push(c);
  }

  /** A transformation of the agent.create request, run in order with the injection. */
  beforeCreate(hook: BeforeCreate): void {
    this.createHooks.push(hook);
  }

  /** A lifecycle subscription that does nothing while the module is switched off. */
  on<Name extends keyof PluginLifecycleEvents>(
    module: ModuleId,
    name: Name,
    handler: (event: PluginLifecycleEvents[Name], context: PluginHookContext) => void | Promise<void>,
  ): () => void {
    return this.server.on(name, (event, context) => {
      this.capture(context);
      if (this.enabled(module)) return handler(event, context);
    });
  }

  private visible(tool: HostTool): boolean {
    return this.enabled(tool.owner) || this.extensions.has(tool.owner);
  }

  private source() {
    return {
      tools: () => [...this.tools.values()].filter((t) => this.visible(t)),
      aliases: () => [...this.aliases.values()].filter((t) => this.visible(t)),
      instructions: () =>
        [...this.instructions.entries()]
          .filter(([owner]) => this.enabled(owner) || this.extensions.has(owner))
          .map(([, text]) => text)
          .join("\n\n"),
    };
  }

  /** The agent.create hook: run the other hooks, then add the `factory` MCP server for the modules that apply. */
  async onCreate(request: CreateRequest, ctx: PluginHookContext): Promise<CreateRequest | void> {
    this.capture(ctx);
    await this.ready;
    let out: CreateRequest = request;
    for (const hook of this.createHooks) {
      const next = await hook(out, ctx);
      if (next) out = next;
    }
    const names: string[] = [];
    const notes: string[] = [];
    for (const c of this.contributions) {
      if (!this.enabled(c.module)) continue;
      const tools = await c.tools(out);
      if (!tools) continue;
      names.push(...tools);
      notes.push(c.note);
    }
    if (names.length === 0) return out === request ? undefined : out;
    await this.started;
    if (!this.url) throw new Error(`${this.startError} Create the agent with the modules' scope variables set to off (PASEO_WARDEN=off, PASEO_INBOX=off, PASEO_LEASES=off) to skip the Factory tools.`);
    const capability = this.sessions.create();
    const preapproved = out.config.toolPolicy?.preapproved ?? [];
    return {
      ...out,
      config: {
        ...out.config,
        systemPrompt: [out.config.systemPrompt, ...notes].filter(Boolean).join("\n\n"),
        mcpServers: {
          ...out.config.mcpServers,
          [SERVER_NAME]: { type: "http", url: `${this.url}/mcp`, headers: { authorization: `Bearer ${capability}` }, alwaysLoad: true },
        },
        toolPolicy: {
          ...out.config.toolPolicy,
          preapproved: [...preapproved, ...names.map((tool) => ({ kind: "mcp" as const, server: SERVER_NAME, tool }))],
        },
      },
      env: { ...out.env, [CAPABILITY_ENV]: capability },
    };
  }

  /** The agent.session_open hook: bind the capability to the agent. */
  onSessionOpen(env: Record<string, string>, agentId: string): void {
    const capability = env[CAPABILITY_ENV];
    if (capability) this.sessions.bind(capability, agentId);
  }

  onArchived(agentId: string): void {
    this.sessions.forgetAgent(agentId);
    this.labelCache.delete(agentId);
  }

  // ---- extensions ----

  listExtensions(): Extension[] {
    return [...this.extensions.values()];
  }

  extension(id: string): Extension | undefined {
    return this.extensions.get(id);
  }

  /** Listeners told when an extension registers (the Blueprints module reads stage kinds from them). */
  onExtension: ((e: Extension) => void)[] = [];

  registerExtension(reg: ExtensionRegistration): () => void {
    const ext: Extension = { ...reg, tab: reg.tab ?? null, stageKinds: reg.stageKinds ?? [], roles: reg.roles ?? [], rpc: reg.rpc ?? [] };
    for (const r of ext.rpc) if (!/^[a-z][a-z0-9_-]*$/.test(r.name)) throw new Error(`rpc name "${r.name}" must be lowercase letters, digits, '-' and '_'`);
    if (!/^[a-z][a-z0-9-]*$/.test(ext.id)) throw new Error(`extension id "${ext.id}" must be lowercase letters, digits and '-'`);
    if (this.extensions.has(ext.id) || (MODULES_SET as Set<string>).has(ext.id)) throw new Error(`extension "${ext.id}" is already registered`);
    for (const t of ext.tools) if (this.tools.has(t.name)) throw new Error(`tool "${t.name}" already exists`);
    this.extensions.set(ext.id, ext);
    const removeTools = this.registerTools(ext.id, ext.tools);
    for (const l of this.onExtension) l(ext);
    return () => {
      removeTools();
      this.extensions.delete(ext.id);
    };
  }

  /**
   * Register (or re-register, idempotently) an extension that lives in another plugin's process.
   * It is dropped after MAX_FAILURES consecutive unreachable calls or health probes.
   */
  registerRemote(raw: import("./remote").RemoteRegistration): void {
    const old = this.remotes.get(raw.id);
    if (old) old.remove();
    else if (this.extensions.has(raw.id)) throw new Error(`extension "${raw.id}" is already registered in-process`);
    const handle = buildRemote(raw, this.pending);
    const removeInner = this.registerExtension(handle.registration);
    const entry = {
      handle,
      remove: () => {
        removeInner();
        if (this.remotes.get(raw.id) === entry) this.remotes.delete(raw.id);
      },
    };
    this.remotes.set(raw.id, entry);
  }

  /** Probe the remote extensions; drop the ones that stay unreachable. */
  async checkRemotes(): Promise<string[]> {
    const dropped: string[] = [];
    for (const [id, { handle, remove }] of [...this.remotes]) {
      if (handle.failures < MAX_FAILURES) await probe(handle);
      if (handle.failures >= MAX_FAILURES) {
        remove();
        dropped.push(id);
        console.error(`factory: extension "${id}" dropped, its callback is unreachable`);
      }
    }
    return dropped;
  }

  /** Run an extension's backend call: input and output are validated with the extension's schemas. */
  async callExtension(id: string, name: string, input: unknown, callerId = "user"): Promise<unknown> {
    const rpc = this.extensions.get(id)?.rpc.find((r) => r.name === name);
    if (!rpc) throw new Error(`extension "${id}" has no rpc "${name}"`);
    const parsed = rpc.input.parse(input ?? {});
    return rpc.output.parse(await rpc.run(parsed, { callerId }));
  }

  /** Services an extension gets in its stage kinds and tools. */
  services: Record<string, unknown> = {};

  private registerGlobal(): void {
    const g = globalThis as Record<symbol, unknown>;
    const key = Symbol.for("paseo.factory");
    g[key] = { registerExtension: (reg: ExtensionRegistration) => this.registerExtension(reg), services: () => this.services, checkRemotes: () => this.checkRemotes() };
    registerWithHost(g, this);
  }

  // ---- http ----

  start(port = Number(process.env.FACTORY_PORT ?? DEFAULT_PORT)): void {
    const mcp = new McpServer(this.source());
    this.started = new Promise<void>((resolve) => {
      const server = createServer((req, res) => {
        this.route(req, mcp).then(
          ({ status, body }) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(body === null ? undefined : JSON.stringify(body));
          },
          (err) => {
            const status = err instanceof HttpError ? err.status : 500;
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          },
        );
      });
      server.once("error", (err: Error) => {
        this.startError = `factory cannot listen on 127.0.0.1:${port}: ${err.message}. Set FACTORY_PORT on the daemon.`;
        console.error(this.startError);
        resolve();
      });
      server.listen(port, "127.0.0.1", () => {
        this.http = server;
        this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        this.writeEndpoint();
        resolve();
      });
    });
  }

  private healthTimer: any = null;

  private writeEndpoint(): void {
    this.healthTimer ??= setInterval(() => void this.checkRemotes().catch(() => undefined), 60_000);
    this.healthTimer.unref?.();
    try {
      const file = endpointFile();
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ url: this.url, token: this.endpointToken }), { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch (error) {
      console.error("factory: could not write the endpoint file", error);
    }
  }

  private bearer(req: IncomingMessage): string | undefined {
    return /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  }

  private async route(req: IncomingMessage, mcp: McpServer): Promise<{ status: number; body: unknown }> {
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return { status: 403, body: { error: "forbidden host" } };
    const pathname = (req.url ?? "").split("?")[0];

    if (pathname === "/extensions/register" || /^\/stages\/[^/]+\/outcome$/.test(pathname) || pathname === "/extensions/unregister") {
      const given = Buffer.from(this.bearer(req) ?? "");
      const want = Buffer.from(this.endpointToken);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return { status: 401, body: { error: "unauthorized" } };
      if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
      let input: any;
      try {
        input = JSON.parse(await readBody(req));
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
      if (pathname === "/extensions/register") {
        const parsed = remoteRegistrationSchema.safeParse(input);
        if (!parsed.success) return { status: 400, body: { error: z.prettifyError(parsed.error) } };
        try {
          this.registerRemote(parsed.data);
        } catch (error) {
          return { status: 400, body: { error: (error as Error).message } };
        }
        return { status: 200, body: { ok: true, id: parsed.data.id } };
      }
      if (pathname === "/extensions/unregister") {
        const known = typeof input?.id === "string" && this.remotes.get(input.id);
        if (known) known.remove();
        return { status: 200, body: { ok: !!known } };
      }
      const token = pathname.split("/")[2];
      const outcome = input?.outcome ?? input;
      if (typeof outcome?.verdict !== "string") return { status: 400, body: { error: "outcome.verdict is required" } };
      return this.pending.complete(token, { verdict: outcome.verdict, summary: outcome.summary, data: outcome.data })
        ? { status: 200, body: { ok: true } }
        : { status: 404, body: { error: "no stage waits for this token" } };
    }

    if (pathname === "/blueprints" || pathname === "/blueprints/start") {
      const given = Buffer.from(this.bearer(req) ?? "");
      const want = Buffer.from(this.endpointToken);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return { status: 401, body: { error: "unauthorized" } };
      if (!this.blueprints || !this.enabled("blueprints")) return { status: 404, body: { error: "blueprints are off" } };
      if (pathname === "/blueprints") {
        if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
        return { status: 200, body: { blueprints: this.blueprints.list() } };
      }
      if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
      let input: any;
      try {
        input = JSON.parse(await readBody(req));
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
      if (typeof input?.blueprint !== "string") return { status: 400, body: { error: "blueprint is required" } };
      const vars = input.vars ?? {};
      if (typeof vars !== "object" || Array.isArray(vars) || Object.values(vars).some((v) => typeof v !== "string")) {
        return { status: 400, body: { error: "vars must be an object of strings" } };
      }
      return {
        status: 200,
        body: this.blueprints.start({
          blueprint: input.blueprint,
          vars,
          requestedBy: typeof input.requestedBy === "string" ? input.requestedBy : "http",
          idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined,
        }),
      };
    }

    if (pathname !== "/mcp") return { status: 404, body: { error: "not found" } };
    if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
    const session = this.sessions.resolve(this.bearer(req));
    if (!session) return { status: 401, body: { error: "unknown or expired capability; recreate the agent" } };
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message } };
    }
    if (!session.agentId) return { status: 503, body: { error: "agent session not bound yet; retry shortly" } };
    const callerId = session.agentId;
    const ctx: CallContext = { callerId, labels: () => this.labelsOf(callerId) };
    const reply = await mcp.handle(payload, ctx);
    this.afterCall.forEach((f) => f());
    return reply ? { status: 200, body: reply } : { status: 202, body: null };
  }

  /** Run after each MCP request (leases wake agents right away). */
  afterCall: (() => void)[] = [];

  stop(): Promise<void> {
    this.unsubscribe();
    if (this.healthTimer) clearInterval(this.healthTimer);
    return new Promise((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }
}

const MODULES_SET = new Set(["roles", "blueprints", "leases", "warden", "inbox"]);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
