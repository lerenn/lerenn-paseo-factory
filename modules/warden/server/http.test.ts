import { afterEach, describe, expect, it } from "vitest";
import { settingsSchema } from "../shared/settings";
import { Engine } from "./engine";
import { WardenHttp } from "./http";
import { McpServer } from "./mcp";
import { Store } from "./store";
import { TOOLS } from "./tools";

let http: WardenHttp | null = null;
afterEach(async () => {
  await http?.stop();
  http = null;
});

async function boot() {
  const store = new Store(null);
  const engine = new Engine(store, { send: async () => {}, watch() {}, unwatch() {} }, () => settingsSchema.parse({}));
  http = new WardenHttp({ engine, mcp: new McpServer(TOOLS) });
  const url = await http.start(0);
  const post = (token: string | undefined, body: object) =>
    fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { store, engine, post };
}

describe("http endpoint", () => {
  it("rejects unknown capabilities", async () => {
    const { post } = await boot();
    expect((await post("nope", {})).status).toBe(401);
    expect((await post(undefined, {})).status).toBe(401);
  });

  it("waits for the session to be bound to an agent", async () => {
    const { store, post } = await boot();
    const token = store.createSession();
    expect((await post(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(503);
  });

  it("serves tools to the bound agent", async () => {
    const { store, engine, post } = await boot();
    const token = store.createSession();
    store.bind(token, "agent-1");
    const res = await post(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "warden_register", arguments: { task: "wait", interval_minutes: 5 } },
    });
    expect(res.status).toBe(200);
    expect(engine.store.active("agent-1")).toHaveLength(1);
  });
});
