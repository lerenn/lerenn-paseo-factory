import { afterEach, describe, expect, it } from "vitest";
import { settingsSchema } from "../shared/settings";
import { Engine } from "./engine";
import { InboxHttp } from "./http";
import { McpServer } from "./mcp";
import { Store } from "./store";
import { TOOLS } from "./tools";

let http: InboxHttp | null = null;
afterEach(async () => {
  await http?.stop();
  http = null;
});

async function boot() {
  const store = new Store(null);
  const engine = new Engine(store, { send: async () => {}, isArchived: async () => false }, () => settingsSchema.parse({}));
  http = new InboxHttp({ engine, mcp: new McpServer(TOOLS) });
  const url = await http.start(0);
  const post = (token: string | undefined, body: object) =>
    fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const agent = (id: string) => {
    const token = store.createSession();
    store.bind(token, id);
    return (method: string, params?: object) => post(token, { jsonrpc: "2.0", id: 1, method, params }).then((r) => r.json() as Promise<any>);
  };
  return { store, engine, post, agent };
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
    const rpc = agent("a1");
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(init.result.instructions).toContain("inbox_ask");
    const tools = await rpc("tools/list");
    expect(tools.result.tools.map((t: any) => t.name)).toEqual(["inbox_ask", "inbox_status", "inbox_list", "inbox_withdraw"]);
  });

  it("asks idempotently and only shows an agent its own items", async () => {
    const { agent, engine } = await boot();
    const a1 = agent("a1");
    const a2 = agent("a2");
    const first = body(await a1("tools/call", call("inbox_ask", { question: "Deploy?", kind: "approval" })));
    const again = body(await a1("tools/call", call("inbox_ask", { question: "Deploy?", kind: "approval" })));
    expect(again.item_id).toBe(first.item_id);
    expect(again.deduped).toBe(true);
    expect(first.next).toContain("End your turn");

    const foreign = await a2("tools/call", call("inbox_status", { item_id: first.item_id }));
    expect(foreign.result.isError).toBe(true);

    engine.answer(first.item_id, { optionId: "deny" });
    const status = body(await a1("tools/call", call("inbox_status", { item_id: first.item_id })));
    expect(status.status).toBe("answered");
    expect(status.answer.option_id).toBe("deny");
    expect(body(await a1("tools/call", call("inbox_list", { status: "pending" })))).toEqual([]);
  });

  it("withdraws and reports usage errors", async () => {
    const { agent } = await boot();
    const a1 = agent("a1");
    const q = body(await a1("tools/call", call("inbox_ask", { question: "q", blocking: false })));
    expect(q.next).toContain("carry on");
    expect(body(await a1("tools/call", call("inbox_withdraw", { item_id: q.item_id }))).status).toBe("withdrawn");
    const bad = await a1("tools/call", call("inbox_ask", { question: "q", default_answer: "x" }));
    expect(bad.result.isError).toBe(true);
  });
});
