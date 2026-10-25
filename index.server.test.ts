import { readFileSync, statSync } from "node:fs";
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
