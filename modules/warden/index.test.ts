import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import contribute from "./index.server";
import { settingsSchema } from "./shared/settings";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function boot(settings: object = {}) {
  process.env.WARDEN_PORT = "0";
  process.env.WARDEN_STATE = path.join(mkdtempSync(path.join(tmpdir(), "warden-")), "state.json");
  const handlers: Record<string, any> = {};
  const sent: { id: string; text: string }[] = [];
  const paseo = {
    workspaces: {
      list: async () => ({
        entries: [{ id: "w", projectDisplayName: "Proj", projectCustomName: null, name: "ws-branch", title: "Nice workspace" }],
      }),
    },
    agents: {
      ref: (id: string) => ({
        send: async (text: string) => void sent.push({ id, text }),
        timeline: { subscribe: () => () => {} },
      }),
    },
  };
  const ctx = { paseo, signal: new AbortController().signal };
  const values = settingsSchema.parse(settings);
  const cleanup = contribute({
    registerSettings: () => ({ read: async () => ({ status: "ready", revision: "1", values }), subscribe: () => () => {} }),
    before: (name: string, h: any) => ((handlers[name] = h), () => {}),
    on: (name: string, h: any) => ((handlers[name] = h), () => {}),
    handle: (contract: { name: string }, h: any) => ((handlers[contract.name] = h), undefined),
  } as never);
  cleanups.push(cleanup as () => void);
  return { handlers, ctx, sent };
}

const request = (env?: Record<string, string>) => ({ request: { config: { provider: "claude", cwd: "/w" }, env } });

describe("plugin entry", () => {
  it("injects the warden MCP server into new agents", async () => {
    const { handlers, ctx } = boot();
    const out = await handlers["agent.create"](request(), ctx);
    expect(out.config.mcpServers.warden.type).toBe("http");
    expect(out.env.PASEO_WARDEN_CAPABILITY).toBeTruthy();
  });

  it("leaves PASEO_WARDEN=off agents alone", async () => {
    const { handlers, ctx } = boot();
    expect(await handlers["agent.create"](request({ PASEO_WARDEN: "off" }), ctx)).toBeUndefined();
  });

  it("with announced-work on, registers a task for an agent that ends a turn announcing work", async () => {
    const { handlers, ctx } = boot({ announcedWork: { enabled: true, intervalMinutes: 5 } });
    await handlers["agent.create"](request(), ctx); // waits for settings
    const agent = { id: "a1", workspaceId: "w", parentAgentId: null, title: "T" };
    handlers["agent.turn_ended"]({ agent, turnId: "1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "Build started. I'll keep watching CI." }] }, ctx);
    const list = await handlers["warden.list"]({}, ctx);
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({ agentId: "a1", source: "announced-work" });
  });

  it("does not register by heuristic when it is off (default)", async () => {
    const { handlers, ctx } = boot();
    await handlers["agent.create"](request(), ctx);
    const agent = { id: "a2", workspaceId: "w", parentAgentId: null, title: "T" };
    handlers["agent.turn_ended"]({ agent, turnId: "1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "I'll keep watching CI." }] }, ctx);
    expect((await handlers["warden.list"]({}, ctx)).tasks).toEqual([]);
  });

  it("stores PASEO_WARDEN_INTERVAL as the agent's default and rejects a bad value at creation", async () => {
    const { handlers, ctx } = boot();
    await expect(handlers["agent.create"](request({ PASEO_WARDEN_INTERVAL: "soon" }), ctx)).rejects.toThrow(/PASEO_WARDEN_INTERVAL/);
    const out = await handlers["agent.create"](request({ PASEO_WARDEN_INTERVAL: "15m" }), ctx);
    const capability = out.env.PASEO_WARDEN_CAPABILITY;
    handlers["agent.session_open"]({ request: { agentId: "a9", env: { PASEO_WARDEN_CAPABILITY: capability, PASEO_WARDEN_INTERVAL: "15m" } } }, ctx);
    const reply = await fetch(`${(await handlers["warden.list"]({}, ctx)).endpoint.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "warden_register", arguments: { task: "t" } } }),
    });
    const body: any = await reply.json();
    expect(JSON.parse(body.result.content[0].text).interval_minutes).toBe(15);
  });

  it("lists project, workspace and conversation names with each task", async () => {
    const { handlers, ctx } = boot({ announcedWork: { enabled: true, intervalMinutes: 5 } });
    await handlers["agent.create"](request(), ctx);
    const agent = { id: "a3", workspaceId: "w", parentAgentId: null, title: "My conversation" };
    handlers["agent.turn_ended"]({ agent, turnId: "1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "I'll keep watching CI." }] }, ctx);
    const [task] = (await handlers["warden.list"]({}, ctx)).tasks;
    expect(task).toMatchObject({ agentId: "a3", agentTitle: "My conversation", projectName: "Proj", workspaceName: "Nice workspace", workspaceId: "w" });
  });
});

describe("/warden command", () => {
  it("registers a user task through the RPC and lists it as the user's", async () => {
    const { handlers, ctx, sent } = boot();
    const out = await handlers["warden.command"]({ agentId: "a5", args: "babysit deploy --interval 3" }, { ...ctx, paseo: { ...ctx.paseo, agents: { ref: (id: string) => ({ send: async (text: string) => void sent.push({ id, text }), timeline: { subscribe: () => () => {}, append: async () => {} } }) } } });
    expect(out.message).toContain("babysit deploy");
    const list = await handlers["warden.list"]({}, ctx);
    expect(list.tasks[0]).toMatchObject({ agentId: "a5", registeredBy: "user", source: "user", intervalMinutes: 3 });
    expect(sent[0].text).toContain("put you under watch");
  });
});
