import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRunRpc, listRunsRpc } from "../shared/blueprints/rpc";
import { syncSourcesRpc } from "../shared/roles/rpc";
import { git, tmp } from "./roles/testing";
import { bootPlugin } from "./testing";
import { overviewRpc } from "../shared/rpc";
import { listItemsRpc } from "../shared/inbox/rpc";

/**
 * The Factory with none of its satellite plugins: no Agents Mail (no endpoint file), no Events, no extension. A fake
 * daemon runs the plugin's hooks the way Paseo does, and the workers answer through the Factory's own MCP endpoint.
 */

const BLUEPRINT = `
version = 1
name = "hello"
description = "Two agent stages, then done."

[[stage]]
id = "work"
role = "worker"
prompt = "Say hello."
[stage.on]
done = "check"

[[stage]]
id = "check"
role = "worker"
prompt = "Check the hello."
[stage.on]
ok = "done"
`;

interface FakeAgent {
  id: string;
  labels: Record<string, string>;
  mcp: Record<string, { url: string; headers: Record<string, string> }>;
  prompt: string;
  status: "idle" | "running";
  archivedAt: string | null;
  /** What the agent "wrote" last: its final assistant message in the timeline. */
  reply: string | null;
}

/**
 * The whole plugin (bootPlugin) on a daemon whose agents exist: creating one runs the plugin's create and session hooks as
 * Paseo does, and the agent keeps what they gave it (its MCP servers, its capability).
 */
function bootWithAgents(settings: Record<string, object>) {
  const agents = new Map<string, FakeAgent>();
  let n = 0;
  let boot: ReturnType<typeof bootPlugin>;
  const view = (a: FakeAgent) => ({ id: a.id, labels: a.labels, status: a.status, archivedAt: a.archivedAt, workspaceId: null, provider: "claude", lastUsage: null });
  const ref = (id: string) => ({
    send: async () => {
      if (!agents.get(id) || agents.get(id)!.archivedAt) throw new Error(`no agent ${id}`);
    },
    refresh: async () => (agents.get(id) ? { agent: view(agents.get(id)!) } : null),
    archive: async () => {
      const a = agents.get(id);
      if (a) a.archivedAt = new Date().toISOString();
    },
    timeline: {
      refetch: async () => ({ entries: agents.get(id)?.reply ? [{ item: { type: "assistant_message", text: agents.get(id)!.reply } }] : [] }),
      subscribe: () => () => undefined,
    },
  });
  boot = bootPlugin(settings, {
    agents: {
      list: async () => ({ entries: [...agents.values()].map((a) => ({ agent: view(a) })) }),
      ref,
      async create(input: any) {
        // The create hooks see the session config and the env, as in Paseo; labels stay with the agent.
        const request = { config: { provider: "claude", ...(input.config ?? {}) }, env: { ...(input.env ?? {}) } };
        const out = (await boot.create(request)) ?? request;
        const id = `agent-${++n}`;
        agents.set(id, { id, labels: { ...(input.labels ?? {}) }, mcp: out.config.mcpServers ?? {}, prompt: String(input.prompt ?? ""), status: "running", archivedAt: null, reply: null });
        await boot.open({ agentId: id, env: out.env });
        return { id };
      },
    },
    workspaces: {
      list: async () => ({ entries: [] }),
      archive: async () => ({ error: null }),
      ref: () => ({ refresh: async () => ({ title: null }), setTitle: async () => ({ title: null }) }),
    },
  });
  /** The agent ends its turn the way the daemon reports it. */
  const turnEnded = (id: string) => {
    const a = agents.get(id)!;
    a.status = "idle";
    return boot.fire("agent.turn_ended", { agent: view(a), outcome: { kind: "completed" }, turnId: `t-${id}` });
  };
  const rpc = (contract: { name: string }, input: unknown) => boot.rpc[contract.name](input, boot.ctx);
  return { boot, agents, rpc, turnEnded };
}

/** A worker calls a Factory tool through the MCP endpoint and the capability its create hook gave it. */
async function callTool(agent: FakeAgent, name: string, args: Record<string, unknown>) {
  const factory = agent.mcp.factory;
  if (!factory) throw new Error(`agent ${agent.id} has no factory MCP server`);
  const res = await fetch(factory.url, {
    method: "POST",
    headers: { ...factory.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
  if (body.error || body.result?.isError) throw new Error(body.error?.message ?? body.result?.content.map((c) => c.text).join(" "));
  return body.result;
}

const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("the Factory with no satellite plugin (no Agents Mail, no Events, no extension)", () => {
  const saved = { ...process.env };
  let daemon: ReturnType<typeof bootWithAgents>;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-standalone-"));
    const blueprints = path.join(root, "blueprints");
    const cwd = path.join(root, "repo");
    for (const dir of [blueprints, cwd]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(blueprints, "hello.toml"), BLUEPRINT);
    writeFileSync(path.join(blueprints, "train.toml"), `version = 1\nname = "train"\n[[stage]]\nid = "pins"\nkind = "train"\n[stage.on]\nok = "done"\n`);
    Object.assign(process.env, { FACTORY_MAIL_ENDPOINT: path.join(root, "no-agents-mail.json"), FACTORY_BLUEPRINTS_DIR: blueprints });
    // Roles come from a git source: a local bare repository with the roles the run needs.
    const origin = await tmp();
    git(origin, "init", "-q", "--bare", "-b", "main");
    const work = await tmp();
    git(work, "clone", "-q", origin, ".");
    git(work, "checkout", "-q", "-b", "main");
    mkdirSync(path.join(work, "factory", "roles"), { recursive: true });
    for (const role of ["worker", "pm", "retro"]) writeFileSync(path.join(work, "factory", "roles", `${role}.yaml`), `name: ${role}\n`);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "roles");
    git(work, "push", "-q", "origin", "main");
    daemon = bootWithAgents({
      roles: { sources: [{ url: origin, ref: "main", path: "factory" }] },
      // A retro and the event mails are asked for: without Mail they must not get lost or break the run.
      blueprints: { defaultCwd: cwd, retro: { mailTo: "@user", skipTrivial: false }, events: { mailTo: "@assistant" } },
    });
    await daemon.rpc(syncSourcesRpc, {});
  });

  afterAll(async () => {
    await (daemon?.boot.cleanup as () => Promise<void> | undefined)?.();
    process.env = saved;
  });

  it("boots, and runs a two-stage blueprint to the end", async () => {
    const overview = await daemon.rpc(overviewRpc, {});
    expect(overview.endpoint.error).toBeNull();
    expect(overview.extensions).toEqual([]);

    const started = await daemon.rpc(startRunRpc, { blueprint: "hello", vars: {} });
    expect(started).toMatchObject({ ok: true, message: null });
    const runId = started.runId as string;

    const worker = (stage: string) => [...daemon.agents.values()].find((a) => a.labels["paseo.factory.run"] === runId && a.labels["paseo.factory.stage"] === stage);
    await until("the first worker", () => !!worker("work"));
    const first = worker("work")!;
    expect(first.prompt).toContain("Say hello.");
    // The Factory gave it its tools, and nothing from a plugin that is not there.
    expect(Object.keys(first.mcp)).toEqual(["factory"]);
    await callTool(first, "blueprint_verdict", { verdict: "done", summary: "said hello" });
    await daemon.turnEnded(first.id);

    await until("the second worker", () => !!worker("check"));
    const second = worker("check")!;
    await callTool(second, "blueprint_verdict", { verdict: "ok", summary: "checked" });
    await daemon.turnEnded(second.id);

    let run: any;
    await until("the run to finish", async () => {
      const list = await daemon.rpc(listRunsRpc, { includeFinished: true });
      run = list.runs.find((r: { id: string }) => r.id === runId);
      return run?.status === "done";
    });
    expect(run.status).toBe("done");

    // The retro: its agent is told Mail is not there, and what it writes is filed in the Factory Inbox as information.
    await until("the retro agent", () => !!worker("retro"));
    const retro = worker("retro")!;
    expect(retro.prompt).toContain("Agents Mail is NOT available here");
    retro.reply = `Factory retro ${runId} · hello: done, 1 min\nTimeline: work, check.\nNothing to improve.`;
    await daemon.turnEnded(retro.id);
    let items: any[] = [];
    await until("the retro in the Inbox", async () => {
      items = (await daemon.rpc(listItemsRpc, {})).items;
      return items.some((i) => i.kind === "info" && i.question.startsWith(`Factory retro ${runId}`));
    });
    const filed = items.find((i) => i.question.startsWith(`Factory retro ${runId}`));
    expect(filed).toMatchObject({ agentId: "factory", kind: "info", blocking: false, status: "pending" });
    expect(filed.context).toContain("Timeline: work, check.");
    expect(filed.context).toContain("For @user");
  }, 30_000);

  it("refuses at start a blueprint whose stage kind no extension provides", async () => {
    const out = await daemon.rpc(startRunRpc, { blueprint: "train", vars: {} });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/stage "pins" has kind "train", and no installed extension provides it/);
  });
});
