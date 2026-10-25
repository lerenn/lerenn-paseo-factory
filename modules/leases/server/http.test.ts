import { afterEach, describe, expect, it } from "vitest";
import { settingsSchema } from "../shared/settings";
import { Engine } from "./engine";
import { LeasesHttp } from "./http";
import { McpServer } from "./mcp";
import { Store } from "./store";
import { TOOLS } from "./tools";

let http: LeasesHttp | null = null;
afterEach(async () => {
  await http?.stop();
  http = null;
});

async function boot() {
  const store = new Store(null);
  const sent: { agentId: string; text: string }[] = [];
  const engine = new Engine(store, { send: async (agentId, text) => void sent.push({ agentId, text }), isArchived: async () => false }, () => settingsSchema.parse({}));
  http = new LeasesHttp({ engine, mcp: new McpServer(TOOLS), onChange: () => void engine.deliver() });
  const url = await http.start(0);
  const post = (token: string | undefined, body: object) =>
    fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const agent = (id: string) => {
    const token = store.createSession();
    store.bind(token, id);
    return (method: string, params?: object) => post(token, { jsonrpc: "2.0", id: 1, method, params }).then((r) => r.json() as Promise<any>);
  };
  return { store, engine, post, agent, sent };
}

const call = (name: string, args: object) => ({ name, arguments: args });
const body = (r: any) => JSON.parse(r.result.content[0].text);

describe("http endpoint", () => {
  it("rejects unknown capabilities", async () => {
    const { post } = await boot();
    expect((await post("nope", {})).status).toBe(401);
    expect((await post(undefined, {})).status).toBe(401);
  });

  it("initializes with instructions and lists the tools", async () => {
    const { agent } = await boot();
    const a = agent("a");
    const init = await a("initialize", { protocolVersion: "2025-06-18" });
    expect(init.result.instructions).toContain("lease_acquire");
    expect(init.result.serverInfo.name).toBe("leases");
    const tools = await a("tools/list");
    expect(tools.result.tools.map((t: any) => t.name)).toEqual(["lease_acquire", "lease_renew", "lease_release", "lease_list"]);
  });

  it("runs queue handover, takeover and a stale token refusal over MCP", async () => {
    const { agent, sent } = await boot();
    const a = agent("a");
    const b = agent("b");
    const c = agent("c");

    const got = body(await a("tools/call", call("lease_acquire", { name: "pr:x/y#1", ttl: 60 })));
    expect(got).toMatchObject({ status: "held", token: 1 });
    const queued = body(await b("tools/call", call("lease_acquire", { name: "pr:x/y#1", ttl: 60 })));
    expect(queued).toMatchObject({ status: "queued", position: 1, held_by: "a" });

    const list = body(await b("tools/call", call("lease_list", {})));
    expect(list[0].holder).toMatchObject({ agent_id: "a", mine: false });
    expect(list[0].holder.token).toBeUndefined();
    expect(list[0].queue[0]).toMatchObject({ agent_id: "b", mine: true });

    expect(body(await a("tools/call", call("lease_release", { name: "pr:x/y#1", token: 1 })))).toMatchObject({ status: "released", handed_to: "b" });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.map((m) => m.agentId)).toEqual(["b"]);

    // a's token is stale now
    const stale = await a("tools/call", call("lease_renew", { name: "pr:x/y#1", token: 1 }));
    expect(stale.result.isError).toBe(true);
    expect(stale.result.content[0].text).toContain("Refused");

    const took = body(await c("tools/call", call("lease_acquire", { name: "pr:x/y#1", ttl: 60, mode: "takeover" })));
    expect(took).toMatchObject({ status: "held", token: 3, took_over_from: "b" });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.map((m) => m.agentId)).toEqual(["b", "b"]);
    expect(sent[1]!.text).toContain("lost lease");
    const bad = await b("tools/call", call("lease_renew", { name: "pr:x/y#1", token: 2 }));
    expect(bad.result.isError).toBe(true);
  });

  it("returns tool errors for invalid input", async () => {
    const { agent } = await boot();
    const r = await agent("a")("tools/call", call("lease_acquire", { name: "bad name!", ttl: 60 }));
    expect(r.result.isError).toBe(true);
  });
});
