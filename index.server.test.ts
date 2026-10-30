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
    expect(tools).toEqual(expect.arrayContaining(["inbox_ask", "lease_acquire", "inbox_answer"]));
    expect(tools).not.toContain("warden_register"); // Warden is for Factory agents only
    expect(tools).not.toContain("blueprint_start");
    expect(out.env.PASEO_FACTORY_CAPABILITY).toBeTruthy();
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
    expect(names).toEqual(expect.arrayContaining(["inbox_ask", "inbox_pending", "lease_acquire", "blueprint_list", "blueprint_verdict"]));
    expect(names).not.toContain("warden_register"); // hidden from agents without the factory label
    expect(names).not.toContain("inbox_answer"); // hidden from agents without the assistant label
    const call = await mcp(endpoint.url, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lease_acquire", arguments: { name: "pr:x#1", ttl: 60 } } });
    expect(JSON.parse(call.body.result.content[0].text)).toMatchObject({ status: "held" });
    expect((await mcp(endpoint.url, "bogus", { jsonrpc: "2.0", id: 3, method: "ping" })).status).toBe(401);
  });

  it("lets an extension keep a live agent's leases over the endpoint", async () => {
    const { create, open, rpc, ctx, dir } = boot();
    const out = await create(request());
    await open({ agentId: "a1", env: out.env });
    const { endpoint } = await rpc["factory.overview"]({}, ctx);
    const cap = out.env.PASEO_FACTORY_CAPABILITY;
    await mcp(endpoint.url, cap, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lease_acquire", arguments: { name: "pr:x#1@abc", ttl: 60, mode: "takeover" } } });
    const { token } = JSON.parse(readFileSync(`${dir}/endpoint.json`, "utf8"));
    const keep = (body: object, auth = token) => fetch(`${endpoint.url}/extensions/leases/keep`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
    expect((await keep({ agentId: "a1", ttlSeconds: 1800 }, "wrong")).status).toBe(401);
    expect((await keep({ ttlSeconds: 1800 })).status).toBe(400);
    const res = await keep({ agentId: "a1", ttlSeconds: 1800, by: "shipit" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kept: ["pr:x#1@abc"] });
    const list = await mcp(endpoint.url, cap, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lease_list", arguments: {} } });
    expect(JSON.parse(list.body.result.content[0].text)[0].holder.expires_in_seconds).toBeGreaterThan(1700);
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
    expect(await create(request({ PASEO_WARDEN: "off", PASEO_INBOX: "off", PASEO_LEASES: "off", PASEO_SUPERVISOR: "off" }))).toBeUndefined();
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
  it("is for agents with a trusted label and is recorded as the Assistant's answer", async () => {
    const asker = "asker";
    const b = bootPlugin({ factory: { trustedLabels: ["paseo.assistant=1"] } }, {
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
    expect(done).toMatchObject({ status: "answered", answer: { option_id: "yes", by: "assistant" }, recorded_as: "answered by the Assistant on behalf of the user" });
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
      id: "shipit",
      version: "1.0.0",
      tab: "Ship It",
      tools: [{ name: "train_status", description: "Status", input: z.object({}), run: () => ({ ok: true }) }],
    });
    const out = await create(request());
    await open({ agentId: "a1", env: out.env });
    const overview = await rpc["factory.overview"]({}, ctx);
    expect(overview.extensions).toEqual([{ id: "shipit", version: "1.0.0", tab: "Ship It", tools: ["train_status"], stageKinds: [], health: "ok" }]);
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
      const getRuns = (path: string, auth = token) => fetch(`${endpoint.url}${path}`, { headers: { authorization: `Bearer ${auth}` } });
      expect((await getRuns("/blueprints/runs", "nope")).status).toBe(401);
      expect((await getRuns("/blueprints/runs?since=-1")).status).toBe(400);
      const all = (await (await getRuns("/blueprints/runs?since=0&has_var=who")).json()) as any;
      expect(all.runs).toEqual([expect.objectContaining({ id: first.runId, blueprint: "demo", status: "done", parent: null, vars: { who: "Louis" }, events: expect.any(Array), stages: expect.any(Object) })]);
      expect(all.runs[0]).toMatchObject({ stage: "hello", waitingFor: null, pmPending: null, suspended: null, gate: null, escalations: [], agentId: null, role: null, prs: {} });
      expect(((await (await getRuns("/blueprints/runs?since=0&has_var=slack_thread_ts")).json()) as any).runs).toEqual([]);
      expect(((await (await getRuns(`/blueprints/runs?since=${Date.now() + 60_000}`)).json()) as any).runs).toEqual([]);
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
      id: "shipit",
      version: "1",
      tab: "Ship It",
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
    expect(await rpc["factory.extension.call"]({ id: "shipit", name: "board", input: { n: 3 } }, ctx)).toEqual({ ok: true, output: { lanes: 3 }, error: null });
    expect((await rpc["factory.overview"]({}, ctx)).extensions.map((e: any) => e.id)).toEqual(["shipit"]);
    void token;
  });

  it("serves read-only rpcs on POST /extensions/<id>/rpc/<name>, and only those", async () => {
    const ext = await extensionServer({
      "/rpc/ticket-facts": (b) => ({ output: { facts: Object.fromEntries(b.input.keys.map((k: string) => [k, [{ label: "lane", value: "dev" }]])), by: b.callerId } }),
      "/rpc/board": () => ({ output: { lanes: 1 } }),
    });
    const f = await factory();
    expect((await f.register({ id: "shipit", version: "1", callback: { url: ext.url, token: "ext-secret-token" }, rpc: [{ name: "ticket-facts", readOnly: true }, { name: "board" }] })).status).toBe(200);
    const call = (p: string, body: object, auth = f.token) => fetch(`${f.endpoint.url}${p}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
    const ok = await call("/extensions/shipit/rpc/ticket-facts", { input: { keys: ["ABC-1"] } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ output: { facts: { "ABC-1": [{ label: "lane", value: "dev" }] }, by: "loopback" } });
    expect((await call("/extensions/shipit/rpc/ticket-facts", { input: { keys: [] } }, "wrong")).status).toBe(401);
    expect((await call("/extensions/shipit/rpc/board", { input: {} })).status).toBe(403);
    expect((await call("/extensions/shipit/rpc/nope", { input: {} })).status).toBe(404);
    expect((await call("/extensions/missing/rpc/ticket-facts", { input: {} })).status).toBe(404);
    expect((await fetch(`${f.endpoint.url}/extensions/shipit/rpc/ticket-facts`, { headers: { authorization: `Bearer ${f.token}` } })).status).toBe(405);
    expect(ext.calls.filter((c) => c.path === "/rpc/board")).toEqual([]); // refused before the extension is reached
  });

  it("refuses an in-process rpc that is not read-only, and validates the input of one that is", async () => {
    const f = await factory();
    const reg = (globalThis as any)[Symbol.for("paseo.factory")] as { registerExtension(r: object): () => void };
    cleanups.push(
      reg.registerExtension({
        id: "local-facts",
        version: "1",
        tools: [],
        rpc: [
          { name: "facts", readOnly: true, input: z.object({ keys: z.array(z.string()).max(200) }), output: z.object({ n: z.number() }), run: (i: { keys: string[] }) => ({ n: i.keys.length }) },
          { name: "poke", input: z.object({}), output: z.unknown(), run: () => "poked" },
        ],
      }),
    );
    const call = (name: string, input: unknown) => fetch(`${f.endpoint.url}/extensions/local-facts/rpc/${name}`, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: JSON.stringify({ input }) });
    expect(await (await call("facts", { keys: ["A", "B"] })).json()).toEqual({ output: { n: 2 } });
    expect((await call("facts", { keys: "A" })).status).toBe(400);
    expect((await call("poke", {})).status).toBe(403);
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

describe("spend", () => {
  it("records the usage of a factory agent's turn once, and aggregates it per run, role and day", async () => {
    const b = bootPlugin({}, {
      agents: {
        list: async () => ({ entries: [{ agent: { id: "w1", labels: { "paseo.factory": "1", "paseo.factory.run": "bp-1", "paseo.factory.blueprint": "ticket", "paseo.factory.role": "implementer", "paseo.factory.stage": "implement" } } }, { agent: { id: "other", labels: {} } }] }),
        ref: () => ({ send: async () => {}, refresh: async () => ({ agent: { archivedAt: null, status: "idle", lastUsage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 50, totalCostUsd: 0.42 } } }), timeline: { subscribe: () => () => {} } }),
      },
    });
    cleanups.push(b.cleanup as () => void);
    await b.rpc["factory.overview"]({}, b.ctx);
    const turn = (id: string, turnId: string) => b.fire("agent.turn_ended", { agent: { id, workspaceId: null, parentAgentId: null, title: null }, turnId, outcome: { kind: "completed" }, timeline: [] });
    await turn("w1", "t1");
    await turn("w1", "t1"); // the same turn again
    await turn("other", "t9"); // not a factory agent
    const report = await until(() => b.rpc["blueprints.spend"]({ days: 30 }, b.ctx), (r) => r.total.turns >= 1);
    expect(report.total).toMatchObject({ turns: 1, inputTokens: 1000, outputTokens: 200, costUsd: 0.42 });
    expect(report.byRun[0]).toMatchObject({ key: "bp-1", blueprint: "ticket" });
    expect(report.byRole[0].key).toBe("implementer");
    expect(report.byDay).toHaveLength(1);
  });
});

describe("activity, run diffs and transcripts", () => {
  it("reports extension events through the endpoint into the feed, newest first", async () => {
    const b = boot();
    const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
    const { token } = JSON.parse(readFileSync(`${b.dir}/endpoint.json`, "utf8"));
    const post = (body: object, auth = token) => fetch(`${endpoint.url}/extensions/event`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
    expect((await post({ id: "shipit", title: "x" }, "bad")).status).toBe(401);
    expect((await post({ id: "shipit" })).status).toBe(400);
    expect((await post({ id: "shipit", type: "deploy", tone: "success", title: "prd deploy of backend v1.2.3" })).status).toBe(200);
    const feed = await b.rpc["factory.activity"]({ limit: 50 }, b.ctx);
    expect(feed.items[0]).toMatchObject({ type: "deploy", tone: "success", title: "prd deploy of backend v1.2.3", link: { tab: "ext:shipit" } });
  });

  it("summarises a run's PRs from GitHub, per PR, with errors kept per PR", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bp-"));
    writeFileSync(path.join(dir, "one.toml"), `name = "one"\nversion = 1\n[[stage]]\nid = "x"\nkind = "greet"\n[stage.on]\nok = "done"\n`);
    process.env.FACTORY_BLUEPRINTS_DIR = dir;
    try {
      const b = boot();
      (globalThis as any)[Symbol.for("paseo.factory")].overrides.prDiff = async (url: string) => {
        if (url.endsWith("/2")) throw new Error("gone");
        return { files: 3, additions: 40, deletions: 5 };
      };
      (globalThis as any)[Symbol.for("paseo.factory")].registerExtension({ id: "g", version: "1", tools: [], stageKinds: [{ kind: "greet", run: async () => ({ verdict: "ok", data: { pr_urls: ["https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"] } }) }] });
      await b.rpc["blueprints.list"]({ includeFinished: true }, b.ctx);
      const { runs } = await until(async () => {
        const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
        const { token } = JSON.parse(readFileSync(`${b.dir}/endpoint.json`, "utf8"));
        await fetch(`${endpoint.url}/blueprints/start`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ blueprint: "one", vars: {}, requestedBy: "t", idempotencyKey: "k" }) });
        return b.rpc["blueprints.list"]({ includeFinished: true }, b.ctx);
      }, (r) => r.runs[0]?.status === "done");
      const diff = await b.rpc["blueprints.diff"]({ runId: runs[0].id }, b.ctx);
      expect(diff.prs).toEqual([
        { url: "https://github.com/a/b/pull/1", filesUrl: "https://github.com/a/b/pull/1/files", files: 3, additions: 40, deletions: 5, error: null },
        { url: "https://github.com/a/b/pull/2", filesUrl: "https://github.com/a/b/pull/2/files", files: null, additions: null, deletions: null, error: "gone" },
      ]);
    } finally {
      delete process.env.FACTORY_BLUEPRINTS_DIR;
    }
  });
});

describe("inbox_ask as a multiple-choice question", () => {
  it("needs 2 to 4 options (or kind approval), derives ids, orders the recommended first, and adds Other", async () => {
    const b = boot();
    const out = await b.create(request());
    await b.open({ agentId: "asker", env: out.env });
    const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
    const call = async (args: object) => (await mcp(endpoint.url, out.env.PASEO_FACTORY_CAPABILITY, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox_ask", arguments: args } })).body.result;
    const none = await call({ question: "Free text please?" });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/2 to 4 options/);
    expect((await call({ question: "One?", options: [{ label: "Only" }] })).isError).toBe(true);
    expect((await call({ question: "Five?", options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })) })).isError).toBe(true);
    const ok = await call({ question: "Which?", options: [{ label: "Roll back" }, { label: "Wait an hour", description: "CI is red", recommended: true }] });
    expect(ok.isError).toBeUndefined();
    const { items } = await b.rpc["inbox.list"]({}, b.ctx);
    expect(items[0].options.map((o: any) => o.id)).toEqual(["wait-an-hour", "roll-back"]);
    expect(items[0]).toMatchObject({ allowFreeText: true });
    const approval = await call({ question: "Deploy?", kind: "approval" });
    expect(approval.isError).toBeUndefined();
  });
});

describe("warden is for Factory agents only", () => {
  const labelled = (labels: Record<string, Record<string, string>>) => ({
    agents: {
      list: async () => ({ entries: Object.entries(labels).map(([id, l]) => ({ agent: { id, labels: l, status: "idle" } })) }),
      ref: (id: string) => ({ send: async () => {}, refresh: async () => ({ agent: { archivedAt: null, status: "idle" } }), timeline: { subscribe: () => () => {}, append: async () => ({}) } }),
    },
  });

  it("injects Warden for Factory workers, shows the tools only to labelled agents and refuses the others", async () => {
    const b = bootPlugin({}, labelled({ worker: { "paseo.factory": "1" }, plain: {} }));
    cleanups.push(b.cleanup as () => void);
    const worker = await b.create(request({ PASEO_FACTORY_RUN: "bp-1" }));
    expect(worker.config.toolPolicy.preapproved.map((t: any) => t.tool)).toContain("warden_register");
    expect(worker.config.systemPrompt).toMatch(/Warden:/);
    const plainOut = await b.create(request());
    expect(plainOut.config.toolPolicy.preapproved.map((t: any) => t.tool)).not.toContain("warden_register");
    const login = async (id: string, out: any) => {
      await b.open({ agentId: id, env: out.env });
      return out.env.PASEO_FACTORY_CAPABILITY as string;
    };
    const workerToken = await login("worker", worker);
    const plainToken = await login("plain", plainOut);
    const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
    const tools = async (token: string) => (await mcp(endpoint.url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools.map((t: any) => t.name);
    expect(await tools(workerToken)).toContain("warden_register");
    expect(await tools(plainToken)).not.toContain("warden_register");
    const call = async (token: string, args: object) => (await mcp(endpoint.url, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "warden_register", arguments: args } })).body.result;
    expect((await call(workerToken, { task: "wait for CI" })).isError).toBeUndefined();
    const refused = await call(plainToken, { task: "x" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/Warden watches Factory agents only|not available/);
  });

  it("drops watches of archived agents and of non-Factory agents", async () => {
    const b = bootPlugin({ warden: { tickSeconds: 5 } }, labelled({ worker: { "paseo.factory": "1" }, plain: {}, other: { "paseo.factory": "1" } }));
    cleanups.push(b.cleanup as () => void);
    await b.rpc["factory.overview"]({}, b.ctx);
    const out = await b.create(request({ PASEO_FACTORY_RUN: "bp-1" }));
    await b.open({ agentId: "worker", env: out.env });
    const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
    await mcp(endpoint.url, out.env.PASEO_FACTORY_CAPABILITY, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "warden_register", arguments: { task: "mine" } } });
    // a user watch on a plain agent and one on an archived (absent) agent, as left by older versions
    const listed = await b.rpc["warden.list"]({}, b.ctx);
    expect(listed.tasks.map((t: any) => t.agentId)).toContain("worker");
    expect((await b.rpc["warden.command"]({ agentId: "plain", args: "babysit" }, b.ctx)).message).toMatch(/Factory agents only/);
  });
});

describe("extension tools for trusted agents and across restarts", () => {
  async function extServer(handlers: Partial<Record<string, (body: any) => unknown>>) {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const handler = handlers[req.url ?? ""];
        res.writeHead(handler ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(handler ? handler(raw ? JSON.parse(raw) : {}) : { error: "nope" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => void server.close());
    return `http://127.0.0.1:${(server.address() as any).port}`;
  }
  const agents = {
    agents: {
      list: async () => ({ entries: [{ agent: { id: "assistant", labels: { "paseo.assistant": "1" } } }, { agent: { id: "plain", labels: {} } }] }),
      ref: () => ({ send: async () => {}, refresh: async () => ({ agent: { archivedAt: null, status: "idle" } }), timeline: { subscribe: () => () => {} } }),
    },
  };
  const registration = (url: string) => ({
    id: "lanes",
    version: "1",
    callback: { url, token: "ext-secret-token" },
    tools: [
      { name: "lanes_board", description: "Read the board", readOnly: true },
      { name: "lanes_drop", description: "Drop an item" },
    ],
  });
  async function start(dir?: string) {
    const b = bootPlugin({ factory: { trustedLabels: ["paseo.assistant=1"] } }, agents, dir);
    const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
    const { token } = JSON.parse(readFileSync(`${b.dir}/endpoint.json`, "utf8"));
    const post = (p: string, body: object) => fetch(`${endpoint.url}${p}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const login = async (id: string) => {
      const out = await b.create(request());
      await b.open({ agentId: id, env: out.env });
      return out.env.PASEO_FACTORY_CAPABILITY as string;
    };
    const listed = async (cap: string) => (await mcp(endpoint.url, cap, { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools as any[];
    const call = async (cap: string, name: string) => (await mcp(endpoint.url, cap, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } })).body.result;
    return { b, post, login, listed, call };
  }

  it("offers a trusted agent an extension's read-only tools and neither lists nor runs its writes", async () => {
    const url = await extServer({ "/tools/lanes_board": () => ({ result: { lanes: 4 } }), "/tools/lanes_drop": () => ({ result: "dropped" }) });
    const f = await start();
    cleanups.push(f.b.cleanup as () => void);
    expect((await f.post("/extensions/register", registration(url))).status).toBe(200);
    const [assistant, plain] = [await f.login("assistant"), await f.login("plain")];
    const forAssistant = await f.listed(assistant);
    expect(forAssistant.map((t) => t.name)).toContain("lanes_board");
    expect(forAssistant.map((t) => t.name)).not.toContain("lanes_drop");
    expect(forAssistant.find((t) => t.name === "lanes_board").annotations).toEqual({ readOnlyHint: true });
    expect(JSON.parse((await f.call(assistant, "lanes_board")).content[0].text)).toEqual({ lanes: 4 });
    const refused = await f.call(assistant, "lanes_drop");
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/not available to this agent/);
    // Other agents keep both, under their own permission flow.
    expect((await f.listed(plain)).map((t) => t.name)).toEqual(expect.arrayContaining(["lanes_board", "lanes_drop"]));
    expect((await f.call(plain, "lanes_drop")).content[0].text).toBe("dropped");
  });

  it("offers a trustedWrite tool to trusted agents only, and tells the extension the caller is trusted", async () => {
    const seen: any[] = [];
    const url = await extServer({
      "/tools/lanes_drop": (body) => (seen.push(body), { result: "dropped" }),
      "/tools/lanes_unblock": (body) => (seen.push(body), { result: "unblocked" }),
    });
    const f = await start();
    cleanups.push(f.b.cleanup as () => void);
    const reg = registration(url);
    reg.tools.push({ name: "lanes_unblock", description: "Clear a lane block", trustedWrite: true } as never);
    expect((await f.post("/extensions/register", reg)).status).toBe(200);
    const [assistant, plain] = [await f.login("assistant"), await f.login("plain")];
    // The trusted agent gets the reads and exactly the trustedWrite tools; not the extension's other writes.
    const forAssistant = (await f.listed(assistant)).map((t) => t.name);
    expect(forAssistant).toEqual(expect.arrayContaining(["lanes_board", "lanes_unblock"]));
    expect(forAssistant).not.toContain("lanes_drop");
    expect((await f.call(assistant, "lanes_unblock")).content[0].text).toBe("unblocked");
    expect(seen.at(-1)).toMatchObject({ callerId: "assistant", trusted: true });
    // Every other agent keeps what it had and never sees, nor runs, the trustedWrite tool.
    const forPlain = (await f.listed(plain)).map((t) => t.name);
    expect(forPlain).toEqual(expect.arrayContaining(["lanes_board", "lanes_drop"]));
    expect(forPlain).not.toContain("lanes_unblock");
    const refused = await f.call(plain, "lanes_unblock");
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/not available to this agent/);
    expect(seen).toHaveLength(1);
    expect((await f.call(plain, "lanes_drop")).content[0].text).toBe("dropped");
    expect(seen.at(-1)).toMatchObject({ callerId: "plain", trusted: false });
  });

  it("keeps the trustedWrite rule for a remote extension's remembered tools while it is away", async () => {
    const url = await extServer({});
    const f = await start();
    cleanups.push(f.b.cleanup as () => void);
    const reg = registration(url);
    reg.tools.push({ name: "lanes_unblock", description: "Clear a lane block", trustedWrite: true } as never);
    expect((await f.post("/extensions/register", reg)).status).toBe(200);
    expect((await f.post("/extensions/unregister", { id: "lanes" })).status).toBe(200);
    const [assistant, plain] = [await f.login("assistant"), await f.login("plain")];
    expect((await f.listed(assistant)).map((t) => t.name)).toContain("lanes_unblock");
    expect((await f.listed(plain)).map((t) => t.name)).not.toContain("lanes_unblock");
  });

  it("keeps listing a remote extension's tools while it is away, also after a Factory restart", async () => {
    const url = await extServer({ "/tools/lanes_board": () => ({ result: "live" }) });
    const first = await start();
    expect((await first.post("/extensions/register", registration(url))).status).toBe(200);
    expect((await first.post("/extensions/unregister", { id: "lanes" })).status).toBe(200);
    const plain = await first.login("plain");
    expect((await first.listed(plain)).map((t) => t.name)).toEqual(expect.arrayContaining(["lanes_board", "lanes_drop"]));
    const away = await first.call(plain, "lanes_board");
    expect(away.isError).toBe(true);
    expect(away.content[0].text).toMatch(/not connected to the Factory right now.*Try again in a minute/);
    await (first.b.cleanup as () => Promise<void>)();

    // A new Factory process: the tools are listed before the extension registers again, with the same access rule.
    const second = await start(first.b.dir);
    cleanups.push(second.b.cleanup as () => void);
    const [assistant, plain2] = [await second.login("assistant"), await second.login("plain")];
    expect((await second.listed(plain2)).map((t) => t.name)).toEqual(expect.arrayContaining(["lanes_board", "lanes_drop"]));
    expect((await second.listed(assistant)).map((t) => t.name)).not.toContain("lanes_drop");
    expect((await second.post("/extensions/register", registration(url))).status).toBe(200);
    expect((await second.call(plain2, "lanes_board")).content[0].text).toBe("live");
    expect((await second.listed(assistant)).filter((t) => t.name === "lanes_board")).toHaveLength(1);
  });
});

describe("the Supervisor", () => {
  it("is reachable by every agent through supervisor_ask / supervisor_status, while reply and restart are its own", async () => {
    process.env.FACTORY_DEFAULT_CWD = "/work";
    try {
      const sent: { id: string; text: string }[] = [];
      const labels: Record<string, Record<string, string>> = { sup: { "paseo.factory": "1", "paseo.factory.supervisor": "1" }, coord: {} };
      const b = bootPlugin({}, {
        agents: {
          create: async () => ({ id: "sup" }),
          list: async () => ({ entries: Object.entries(labels).map(([id, l]) => ({ agent: { id, title: id === "coord" ? "Coordinator" : "Supervisor", labels: l, status: "idle" } })) }),
          ref: (id: string) => ({ send: async (text: string) => void sent.push({ id, text }), refresh: async () => ({ agent: { archivedAt: null, status: "idle" } }), timeline: { subscribe: () => () => {}, append: async () => ({}) } }),
        },
      });
      cleanups.push(b.cleanup as () => void);
      const login = async (id: string) => {
        const out = await b.create(request());
        await b.open({ agentId: id, env: out.env });
        return out.env.PASEO_FACTORY_CAPABILITY as string;
      };
      const coord = await login("coord");
      const sup = await login("sup");
      const { endpoint } = await b.rpc["factory.overview"]({}, b.ctx);
      const call = async (token: string, name: string, args: object = {}) => (await mcp(endpoint.url, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).body.result;
      const names = async (token: string) => (await mcp(endpoint.url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools.map((t: any) => t.name);
      expect(await names(coord)).toEqual(expect.arrayContaining(["supervisor_ask", "supervisor_ask_status", "supervisor_status"]));
      expect(await names(coord)).not.toContain("supervisor_reply");
      expect(await names(coord)).not.toContain("extension_restart");
      expect(await names(sup)).toEqual(expect.arrayContaining(["supervisor_reply", "extension_restart"]));
      expect((await call(coord, "supervisor_reply", { request: "x", answer: "y" })).isError).toBe(true);

      // the tab starts it; supervisor_status then exposes the stable agent id
      expect(await b.rpc["supervisor.start"]({ restart: false }, b.ctx)).toEqual({ ok: true, message: null });
      const status = JSON.parse((await call(coord, "supervisor_status")).content[0].text);
      expect(status).toMatchObject({ agent_id: "sup" });

      // ask -> the Supervisor gets the caller's NAME -> reply -> answer comes back to the asker
      const asking = call(coord, "supervisor_ask", { question: "Is shipit healthy?" });
      const relayed = await until(async () => sent.find((m) => /Supervisor request/.test(m.text)), (m) => !!m);
      expect(relayed!.text).toMatch(/from "Coordinator" \(coord\)/);
      const id = /request (sq-\w+)/.exec(relayed!.text)![1];
      expect((await call(sup, "supervisor_reply", { request: id, answer: "Yes." })).isError).toBeUndefined();
      expect(JSON.parse((await asking).content[0].text)).toMatchObject({ status: "answered", answer: "Yes." });
      const chat = await b.rpc["supervisor.status"]({}, b.ctx);
      expect(chat.status.requests[0]).toMatchObject({ fromName: "Coordinator", answer: "Yes." });

      // the user writes from the tab
      expect(await b.rpc["supervisor.send"]({ text: "status?" }, b.ctx)).toEqual({ ok: true, message: null });
      expect(sent.at(-1)!.text).toBe("Message from the user (Supervisor tab): status?");
    } finally {
      delete process.env.FACTORY_DEFAULT_CWD;
    }
  });
});
