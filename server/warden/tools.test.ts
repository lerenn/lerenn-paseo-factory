import { describe, expect, it } from "vitest";
import { settingsSchema } from "../../shared/warden/settings";
import { Engine } from "./engine";
import { caller as plainCaller, mcpFor } from "../testing";

/** Every agent in these tests is a Factory agent unless a test says otherwise. */
const caller = (id: string) => plainCaller(id, { "paseo.factory": "1" });
import { INSTRUCTIONS } from "./instructions";
import { Store } from "./store";
import { TOOLS } from "./tools";

function setup() {
  const store = new Store(null);
  const engine = new Engine(store, { send: async () => {}, watch() {}, unwatch() {} }, () => settingsSchema.parse({}));
  store.upsertAgent("boss", {});
  store.upsertAgent("worker", { parentId: "boss" });
  store.upsertAgent("stranger", {});
  const mcp = mcpFor(engine, TOOLS, INSTRUCTIONS);
  const call = async (callerId: string, name: string, args: object) => {
    const reply: any = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, caller(callerId));
    const text = reply.result.content[0].text as string;
    return { error: !!reply.result.isError, text, json: reply.result.isError ? null : JSON.parse(text) };
  };
  return { store, engine, call, mcp };
}

describe("mcp", () => {
  it("lists the warden tools with JSON schemas", async () => {
    const { mcp, engine } = setup();
    const reply: any = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, caller("x"));
    const names = reply.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["warden_register", "warden_register_subagent", "warden_update", "warden_done", "warden_list"]);
    expect(reply.result.tools[0].inputSchema.required).toEqual(["task"]);
  });

  it("sends usage instructions in the initialize result", async () => {
    const { mcp, engine } = setup();
    const reply: any = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, caller("x"));
    expect(reply.result.instructions).toMatch(/warden_register/);
    expect(reply.result.instructions).toMatch(/warden_done/);
    expect(reply.result.instructions).toMatch(/"Warden:"/);
  });

  it("answers notifications with nothing", async () => {
    const { mcp, engine } = setup();
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, caller("x"))).toBeNull();
  });
});

describe("tools", () => {
  it("register / update / done lifecycle", async () => {
    const { call, engine } = setup();
    const reg = await call("worker", "warden_register", { task: "build", interval_minutes: 5 });
    expect(reg.json).toMatchObject({ agent_id: "worker", status: "ok" });
    const upd = await call("worker", "warden_update", { task_id: reg.json.task_id, note: "half way" });
    expect(upd.error).toBe(false);
    expect(engine.store.get(reg.json.task_id)?.notes[0].text).toBe("half way");
    const done = await call("worker", "warden_done", { task_id: reg.json.task_id, result: "built" });
    expect(done.json.status).toBe("done");
    expect((await call("worker", "warden_update", { task_id: reg.json.task_id, note: "x" })).error).toBe(true);
  });

  it("uses the creation-time default interval, and an explicit one overrides it", async () => {
    const { call, store } = setup();
    store.upsertAgent("worker", { defaultIntervalMinutes: 15 });
    expect((await call("worker", "warden_register", { task: "a" })).json.interval_minutes).toBe(15);
    expect((await call("worker", "warden_register", { task: "b", interval_minutes: 3 })).json.interval_minutes).toBe(3);
    // a parent guarding the subagent without an interval gets the subagent's default
    expect((await call("boss", "warden_register_subagent", { agent_id: "worker", task: "c" })).json.interval_minutes).toBe(15);
  });

  it("falls back to the 15 min backstop and clamps longer intervals", async () => {
    const { call } = setup();
    expect((await call("worker", "warden_register", { task: "a" })).json.interval_minutes).toBe(15);
    expect((await call("worker", "warden_register", { task: "b", interval_minutes: 120 })).json.interval_minutes).toBe(15);
  });

  it("rejects bad input", async () => {
    const { call } = setup();
    expect((await call("worker", "warden_register", { task: "x", interval_minutes: 0 })).error).toBe(true);
    expect((await call("worker", "warden_register", { task: "x", interval_minutes: 5, until: "tomorrow-ish" })).text).toMatch(/ISO 8601/);
    expect((await call("worker", "warden_register", { task: "x", interval_minutes: 5, until: "2000-01-01T00:00:00Z" })).text).toMatch(/past/);
  });

  it("lets a parent guard its subagent, and manage the task", async () => {
    const { call, engine } = setup();
    const reg = await call("boss", "warden_register_subagent", { agent_id: "worker", task: "review", interval_minutes: 10 });
    expect(reg.json).toMatchObject({ agent_id: "worker" });
    expect(engine.store.get(reg.json.task_id)).toMatchObject({ source: "parent", registeredBy: "boss" });
    expect((await call("worker", "warden_done", { task_id: reg.json.task_id, result: "r" })).json.status).toBe("done");
  });

  it("refuses non-parents and opted-out targets", async () => {
    const { call, store } = setup();
    expect((await call("stranger", "warden_register_subagent", { agent_id: "worker", task: "t", interval_minutes: 5 })).error).toBe(true);
    store.upsertAgent("boss", { optOut: true });
    expect((await call("boss", "warden_register_subagent", { agent_id: "worker", task: "t", interval_minutes: 5 })).text).toMatch(/opted out/);
  });

  it("does not let others touch a task", async () => {
    const { call } = setup();
    const reg = await call("worker", "warden_register", { task: "t", interval_minutes: 5 });
    expect((await call("stranger", "warden_done", { task_id: reg.json.task_id, result: "x" })).error).toBe(true);
    expect((await call("stranger", "warden_list", {})).json).toEqual([]);
    expect((await call("boss", "warden_list", {})).json).toHaveLength(1);
  });

  it("warden_update sets and clears a waiting mark for self or a subagent only", async () => {
    const { call, store } = setup();
    expect((await call("worker", "warden_update", { waiting_on: "CI" })).error).toBe(false);
    expect(store.agent("worker")?.waitingOn).toBe("CI");
    expect((await call("boss", "warden_update", { agent_id: "worker", waiting_on: "" })).error).toBe(false);
    expect(store.agent("worker")?.waitingOn).toBeNull();
    expect((await call("stranger", "warden_update", { agent_id: "worker", waiting_on: "x" })).error).toBe(true);
    expect((await call("boss", "warden_update", {})).error).toBe(true);
  });
});
