import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { bootPlugin } from "./server/testing";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function boot(settings: Record<string, object> = {}) {
  const b = bootPlugin(settings);
  cleanups.push(b.cleanup as () => void);
  return b;
}

const request = (env?: Record<string, string>) => ({ config: { provider: "claude", cwd: "/w" }, env });

async function mcp(url: string, token: string, body: object) {
  const res = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

describe("the factory MCP server", () => {
  it("injects ONE `factory` server for all modules, with a capability and the module notes", async () => {
    const { create } = boot();
    const out = await create(request());
    expect(Object.keys(out.config.mcpServers)).toEqual(["factory"]);
    const tools = out.config.toolPolicy.preapproved.map((t: any) => t.tool);
    expect(tools).toEqual(expect.arrayContaining(["warden_register", "inbox_ask", "lease_acquire", "inbox_answer"]));
    expect(tools).not.toContain("blueprint_start");
    expect(out.env.PASEO_FACTORY_CAPABILITY).toBeTruthy();
    expect(out.config.systemPrompt).toMatch(/Warden:/);
    expect(out.config.systemPrompt).toMatch(/Agents Inbox:/);
    expect(out.config.systemPrompt).toMatch(/Agents Leases:/);
  });

  it("serves every module's tools under one endpoint", async () => {
    const { create, open, rpc, ctx } = boot();
    const out = await create(request());
    await open({ agentId: "a1", env: out.env });
    const { endpoint } = await rpc["factory.overview"]({}, ctx);
    const token = out.env.PASEO_FACTORY_CAPABILITY;
    const listed = await mcp(endpoint.url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = listed.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["inbox_ask", "inbox_pending", "inbox_answer", "lease_acquire", "warden_register", "blueprint_list", "blueprint_verdict"]));
    const call = await mcp(endpoint.url, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lease_acquire", arguments: { name: "pr:x#1", ttl: 60 } } });
    expect(JSON.parse(call.body.result.content[0].text)).toMatchObject({ status: "held" });
    expect((await mcp(endpoint.url, "bogus", { jsonrpc: "2.0", id: 3, method: "ping" })).status).toBe(401);
  });

  it("a module switched off loses its hook injection and its tools", async () => {
    const { create, open, rpc, ctx } = boot({ factory: { modules: { leases: false } } });
    const out = await create(request());
    expect(out.config.toolPolicy.preapproved.map((t: any) => t.tool)).not.toContain("lease_acquire");
    await open({ agentId: "a1", env: out.env });
    const { endpoint } = await rpc["factory.overview"]({}, ctx);
    const listed = await mcp(endpoint.url, out.env.PASEO_FACTORY_CAPABILITY, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.body.result.tools.map((t: any) => t.name)).not.toContain("lease_acquire");
  });

  it("leaves agents alone when every module opts out", async () => {
    const { create } = boot();
    expect(await create(request({ PASEO_WARDEN: "off", PASEO_INBOX: "off", PASEO_LEASES: "off" }))).toBeUndefined();
  });

  it("gives the PM role the blueprint tools and stage workers only the verdict tools", async () => {
    const { create } = boot();
    const pm = await create(request({ PASEO_FACTORY_BLUEPRINTS: "on" }));
    expect(pm.config.toolPolicy.preapproved.map((t: any) => t.tool)).toContain("blueprint_start");
    const worker = await create(request({ PASEO_FACTORY_RUN: "bp-1" }));
    const tools = worker.config.toolPolicy.preapproved.map((t: any) => t.tool);
    expect(tools).toContain("blueprint_verdict");
    expect(tools).not.toContain("blueprint_start");
  });
});

describe("the blueprint start endpoint", () => {
  it("is written 0600 with url and token, and enforces the bearer token", async () => {
    const { rpc, ctx, dir } = boot();
    const { endpoint } = await rpc["factory.overview"]({}, ctx);
    const file = `${dir}/endpoint.json`;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.url).toBe(endpoint.url);
    const get = (token?: string) => fetch(`${written.url}/blueprints`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await get()).status).toBe(401);
    expect((await get("nope")).status).toBe(401);
    expect((await get(written.token)).status).toBe(200);
    const start = (token: string, body: object) => fetch(`${written.url}/blueprints/start`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await start("nope", {})).status).toBe(401);
    expect((await start(written.token, { blueprint: "missing", vars: {} })).status).toBe(404);
    expect((await start(written.token, { blueprint: "x", vars: { a: 1 } })).status).toBe(400);
  });
});

describe("inbox_answer", () => {
  it("is for agents labelled paseo.assistant=1 and is recorded as the Assistant's answer", async () => {
    const asker = "asker";
    const b = bootPlugin({}, {
      agents: {
        list: async () => ({ entries: [{ agent: { id: "assistant", labels: { "paseo.assistant": "1" } } }, { agent: { id: "plain", labels: {} } }] }),
        ref: (id: string) => ({ send: async () => {}, refresh: async () => ({ agent: { archivedAt: null, status: "idle" } }), timeline: { subscribe: () => () => {} } }),
      },
    });
    cleanups.push(b.cleanup as () => void);
    const login = async (id: string) => {
      const out = await b.create(request());
      await b.open({ agentId: id, env: out.env });
      return out.env.PASEO_FACTORY_CAPABILITY as string;
    };
    const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
    const [assistant, plain, askerToken] = [await login("assistant"), await login("plain"), await login(asker)];
    const call = async (token: string, name: string, args: object) => JSON.parse((await mcp(endpoint.url, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).body.result.content[0].text.replace(/^([^{[].*)$/s, '{"error":"$1"}'));
    const asked = await call(askerToken, "inbox_ask", { question: "Merge?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] });
    expect((await call(plain, "inbox_pending", {})).length).toBe(0);
    const pending = await call(assistant, "inbox_pending", {});
    expect(pending.map((i: any) => i.item_id)).toEqual([asked.item_id]);
    const denied = await mcp(endpoint.url, plain, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox_answer", arguments: { item: asked.item_id, answer: "yes" } } });
    expect(denied.body.result.isError).toBe(true);
    const done = await call(assistant, "inbox_answer", { item: asked.item_id, answer: "yes" });
    expect(done).toMatchObject({ status: "answered", answer: { option_id: "yes", by: "assistant" }, recorded_as: "answered by the Assistant on behalf of Louis" });
    const { items } = await b.rpc["inbox.list"]({ audit: true }, b.ctx);
    expect(items[0].answer.by).toBe("assistant");
  });
});

async function until<T = any>(read: () => Promise<T>, ok: (v: any) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("extension rpc", () => {
  const register = (reg: object) => ((globalThis as any)[Symbol.for("paseo.factory")] as { registerExtension(r: object): () => void }).registerExtension(reg);

  it("serves validated backend calls for an extension tab", async () => {
    const { rpc, ctx } = boot();
    const remove = register({
      id: "board",
      version: "1",
      tab: "Board",
      tools: [],
      rpc: [{ name: "lanes", input: z.object({ n: z.number() }), output: z.object({ lanes: z.number() }), run: ({ n }: { n: number }) => ({ lanes: n * 2 }) }, { name: "bad", input: z.object({}), output: z.object({ a: z.string() }), run: () => ({ a: 1 }) }],
    });
    expect(await rpc["factory.extension.call"]({ id: "board", name: "lanes", input: { n: 2 } }, ctx)).toEqual({ ok: true, output: { lanes: 4 }, error: null });
    expect((await rpc["factory.extension.call"]({ id: "board", name: "lanes", input: { n: "x" } }, ctx)).ok).toBe(false);
    expect((await rpc["factory.extension.call"]({ id: "board", name: "bad" }, ctx)).ok).toBe(false);
    expect((await rpc["factory.extension.call"]({ id: "board", name: "missing" }, ctx)).error).toMatch(/no rpc/);
    expect(() => register({ id: "b2", version: "1", tools: [], rpc: [{ name: "Bad Name", input: z.object({}), output: z.object({}), run: () => ({}) }] })).toThrow(/lowercase/);
    remove();
  });
});

describe("extensions", () => {
  const register = (reg: object) => ((globalThis as any)[Symbol.for("paseo.factory")] as { registerExtension(r: object): () => void }).registerExtension(reg);

  it("add tools to the factory server and a tab, with no sidebar row of their own", async () => {
    const { create, open, rpc, ctx } = boot();
    const remove = register({
      id: "release-trains",
      version: "1.0.0",
      tab: "Release Trains",
      tools: [{ name: "train_status", description: "Status", input: z.object({}), run: () => ({ ok: true }) }],
    });
    const out = await create(request());
    await open({ agentId: "a1", env: out.env });
    const overview = await rpc["factory.overview"]({}, ctx);
    expect(overview.extensions).toEqual([{ id: "release-trains", version: "1.0.0", tab: "Release Trains", tools: ["train_status"], stageKinds: [] }]);
    const listed = await mcp(overview.endpoint.url, out.env.PASEO_FACTORY_CAPABILITY, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.body.result.tools.map((t: any) => t.name)).toContain("train_status");
    const called = await mcp(overview.endpoint.url, out.env.PASEO_FACTORY_CAPABILITY, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "train_status", arguments: {} } });
    expect(JSON.parse(called.body.result.content[0].text)).toEqual({ ok: true });
    remove();
    expect((await rpc["factory.overview"]({}, ctx)).extensions).toEqual([]);
  });

  it("refuse a module id, a repeated id and a repeated tool name", () => {
    boot();
    const tool = { name: "x_tool", description: "d", input: z.object({}), run: () => 1 };
    expect(() => register({ id: "warden", version: "1", tools: [] })).toThrow(/already registered/);
    const remove = register({ id: "ext-a", version: "1", tools: [tool] });
    expect(() => register({ id: "ext-a", version: "1", tools: [] })).toThrow(/already registered/);
    expect(() => register({ id: "ext-b", version: "1", tools: [tool] })).toThrow(/already exists/);
    expect(() => register({ id: "inbox_ask", version: "1", tools: [] })).toThrow(/lowercase/);
    remove();
  });

  it("provide stage kinds that blueprints use, started through the HTTP endpoint", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bp-"));
    writeFileSync(
      path.join(dir, "demo.toml"),
      `name = "demo"\nversion = 1\n[vars.who]\ndefault = "world"\n[[stage]]\nid = "hello"\nkind = "greet"\nname = "{{who}}"\n[stage.on]\nok = "done"\nerror = "failed"\n`,
    );
    process.env.FACTORY_BLUEPRINTS_DIR = dir;
    try {
      const { rpc, ctx, dir: data } = boot();
      const seen: unknown[] = [];
      register({
        id: "greeter",
        version: "1",
        tools: [],
        stageKinds: [{ kind: "greet", run: async (c: any) => (seen.push(c.params), { verdict: "ok", summary: `hello ${c.params.name}` }) }],
      });
      const { endpoint } = await rpc["factory.overview"]({}, ctx);
      await rpc["blueprints.list"]({ includeFinished: true }, ctx); // loads the catalog
      const { token } = JSON.parse(readFileSync(`${data}/endpoint.json`, "utf8"));
      const post = () => fetch(`${endpoint.url}/blueprints/start`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ blueprint: "demo", vars: { who: "Louis" }, requestedBy: "events", idempotencyKey: "k" }) });
      const firstRes = await post();
      const first = (await firstRes.json()) as { runId: string };
      expect(first).toEqual({ runId: expect.any(String) });
      const again = (await (await post()).json()) as { runId: string };
      expect(again.runId).toBe(first.runId);
      const { runs } = (await until(() => rpc["blueprints.list"]({ includeFinished: true }, ctx), (r) => r.runs[0]?.status === "done")) as any;
      expect(runs[0]).toMatchObject({ id: first.runId, status: "done", requestedBy: "events" });
      expect(seen).toEqual([{ name: "Louis" }]);
      const listed = (await (await fetch(`${endpoint.url}/blueprints`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;
      expect(listed.blueprints[0]).toMatchObject({ name: "demo", vars: [{ name: "who", required: false }] });
    } finally {
      delete process.env.FACTORY_BLUEPRINTS_DIR;
    }
  });
});

describe("remote extensions (another plugin's process)", () => {
  async function extensionServer(handlers: Record<string, ((body: any) => any) | undefined>) {
    const calls: { path: string; auth: string | undefined; body: any }[] = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = data ? JSON.parse(data) : {};
        calls.push({ path: req.url ?? "", auth: req.headers.authorization, body });
        const handler: ((b: any) => any) | undefined = handlers[req.url ?? ""];
        res.writeHead(handler ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(handler ? handler(body) : { error: "nope" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    cleanups.push(() => void server.close());
    return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  async function factory() {
    const b = boot();
    const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
    const { token } = JSON.parse(readFileSync(`${b.dir}/endpoint.json`, "utf8"));
    const register = (body: object, auth = token) => fetch(`${endpoint.url}/extensions/register`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
    return { ...b, endpoint, token, register };
  }

  it("registers over the endpoint, forwards tools, rpc and stage kinds, and is idempotent", async () => {
    const ext = await extensionServer({
      "/tools/train_status": (b) => ({ result: { echoed: b.input, by: b.callerId } }),
      "/rpc/board": (b) => ({ output: { lanes: b.input.n } }),
      "/stages/train": (b) => ({ outcome: { verdict: "ok", summary: `train ${b.params.name}` } }),
    });
    const { register, rpc, ctx, create, open, endpoint, token } = await factory();
    const body = {
      id: "release-trains",
      version: "1",
      tab: "Release Trains",
      callback: { url: ext.url, token: "ext-secret-token" },
      tools: [{ name: "train_status", description: "Status", inputSchema: { type: "object", properties: { lane: { type: "string" } } } }],
      rpc: [{ name: "board" }],
      stageKinds: [{ kind: "train" }],
    };
    expect((await register(body, "wrong")).status).toBe(401);
    expect((await register({ ...body, callback: { url: "http://example.com", token: "ext-secret-token" } })).status).toBe(400);
    expect((await register(body)).status).toBe(200);
    expect((await register(body)).status).toBe(200); // re-register after a restart of either side

    const out = await create(request());
    await open({ agentId: "a1", env: out.env });
    const cap = out.env.PASEO_FACTORY_CAPABILITY;
    const listed = await mcp(endpoint.url, cap, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.body.result.tools.find((t: any) => t.name === "train_status").inputSchema).toEqual(body.tools[0].inputSchema);
    const called = await mcp(endpoint.url, cap, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "train_status", arguments: { lane: "dev" } } });
    expect(JSON.parse(called.body.result.content[0].text)).toEqual({ echoed: { lane: "dev" }, by: "a1" });
    expect(ext.calls[0].auth).toBe("Bearer ext-secret-token");
    expect(await rpc["factory.extension.call"]({ id: "release-trains", name: "board", input: { n: 3 } }, ctx)).toEqual({ ok: true, output: { lanes: 3 }, error: null });
    expect((await rpc["factory.overview"]({}, ctx)).extensions.map((e: any) => e.id)).toEqual(["release-trains"]);
    void token;
  });

  it("completes a waiting stage through POST /stages/<token>/outcome", async () => {
    let outcomeToken = "";
    const ext = await extensionServer({ "/stages/wait": (b) => ((outcomeToken = b.outcomeToken), { pending: true }) });
    const dir = mkdtempSync(path.join(tmpdir(), "bp-"));
    writeFileSync(path.join(dir, "waiter.toml"), `name = "waiter"\nversion = 1\n[[stage]]\nid = "w"\nkind = "wait"\n[stage.on]\nok = "done"\nerror = "failed"\n`);
    process.env.FACTORY_BLUEPRINTS_DIR = dir;
    try {
      const f = await factory();
      await f.register({ id: "waiter-ext", version: "1", callback: { url: ext.url, token: "ext-secret-token" }, stageKinds: [{ kind: "wait" }] });
      await f.rpc["blueprints.list"]({ includeFinished: true }, f.ctx);
      const started = await fetch(`${f.endpoint.url}/blueprints/start`, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: JSON.stringify({ blueprint: "waiter", vars: {}, requestedBy: "t" }) });
      const { runId } = (await started.json()) as { runId: string };
      await until(async () => outcomeToken, (t) => !!t);
      let runs = (await f.rpc["blueprints.list"]({ includeFinished: true }, f.ctx)).runs;
      expect(runs[0]).toMatchObject({ id: runId, status: "running" });
      const done = await fetch(`${f.endpoint.url}/stages/${outcomeToken}/outcome`, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: JSON.stringify({ verdict: "ok", summary: "merged" }) });
      expect(done.status).toBe(200);
      runs = ((await until(() => f.rpc["blueprints.list"]({ includeFinished: true }, f.ctx), (r) => r.runs[0]?.status === "done")) as any).runs;
      expect(runs[0]).toMatchObject({ status: "done" });
      expect((await fetch(`${f.endpoint.url}/stages/${outcomeToken}/outcome`, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: JSON.stringify({ verdict: "ok" }) })).status).toBe(404);
    } finally {
      delete process.env.FACTORY_BLUEPRINTS_DIR;
    }
  });

  it("drops an extension whose callback stays unreachable, and it can register again", async () => {
    const ext = await extensionServer({ "/health": () => ({ ok: true }), "/tools/ping": () => ({ result: "pong" }) });
    const f = await factory();
    const body = { id: "flaky", version: "1", callback: { url: ext.url, token: "ext-secret-token" }, tools: [{ name: "ping_tool" }] };
    await f.register(body);
    expect((await f.rpc["factory.overview"]({}, f.ctx)).extensions).toHaveLength(1);
    await ext.close();
    const check = () => ((globalThis as any)[Symbol.for("paseo.factory")] as { checkRemotes(): Promise<string[]> }).checkRemotes();
    expect(await check()).toEqual([]);
    expect(await check()).toEqual([]);
    expect(await check()).toEqual(["flaky"]);
    expect((await f.rpc["factory.overview"]({}, f.ctx)).extensions).toEqual([]);
    const again = await extensionServer({});
    expect((await f.register({ ...body, callback: { url: again.url, token: "ext-secret-token" } })).status).toBe(200);
    expect((await f.rpc["factory.overview"]({}, f.ctx)).extensions).toHaveLength(1);
  });
});
