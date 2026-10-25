import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import contribute from "../index.server";
import { agentCreateHook, sessionOpenHook } from "./hook";
import { RoleLimits } from "./limits";

const request = (env?: Record<string, string>) => ({ request: { config: { provider: "claude", cwd: "/x" }, env } });

describe("agent.create hook", () => {
  it("leaves agents without a role untouched", async () => {
    expect(await agentCreateHook(async () => [])(request())).toBeUndefined();
  });

  it("applies a role found in a git source folder, earlier folders first", async () => {
    const a = await mkdtemp(path.join(tmpdir(), "hook-a-"));
    const b = await mkdtemp(path.join(tmpdir(), "hook-b-"));
    await writeFile(path.join(a, "r.yaml"), "name: r\nmodel: from-a\nenv:\n  PASEO_KUBE_TEMPLATE: t\n");
    await writeFile(path.join(b, "r.yaml"), "name: r\nmodel: from-b\n");
    const out = await agentCreateHook(async () => [a, b])(request({ PASEO_AGENT_ROLE: "r" }));
    expect(out?.config.model).toBe("from-a");
    expect(out?.env).toMatchObject({ PASEO_AGENT_ROLE: "r", PASEO_KUBE_TEMPLATE: "t" });
  });

  it("applies the role picked in the Role picker, and ignores No role", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hook-"));
    await writeFile(path.join(dir, "r.yaml"), "name: r\nmodel: picked\n");
    const create = agentCreateHook(async () => [dir]);
    const withOptions = (role: string) => ({
      request: { config: { provider: "claude", cwd: "/x" }, pluginOptions: { "agents-roles": { role } } },
    });
    const out = await create(withOptions("r"));
    expect(out?.config.model).toBe("picked");
    expect(out?.env).toMatchObject({ PASEO_AGENT_ROLE: "r" });
    expect(await create(withOptions("~none"))).toBeUndefined();
  });

  it("fails creation for an unknown role, saying where it looked", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hook-"));
    await expect(agentCreateHook(async () => [dir])(request({ PASEO_AGENT_ROLE: "reviewer" }))).rejects.toThrow(
      /no such role in the git sources/,
    );
  });

  it("explains when no git source is configured", async () => {
    await expect(agentCreateHook(async () => [])(request({ PASEO_AGENT_ROLE: "reviewer" }))).rejects.toThrow(
      /no git source is configured/,
    );
  });
});

describe("concurrency limit", () => {
  const ctx = (status: string) => ({ paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { status, archivedAt: null } }) }) } } }) as never;

  it("refuses creation over maxConcurrent and counts agents registered at session open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hook-"));
    await writeFile(path.join(dir, "r.yaml"), "name: r\nmaxConcurrent: 1\nmodel: m\n");
    const limits = new RoleLimits(path.join(dir, "agents.json"));
    const create = agentCreateHook(async () => [dir], limits);
    const open = sessionOpenHook(limits);
    const env = { PASEO_AGENT_ROLE: "r" };

    const first = await create(request(env), ctx("running"));
    expect(first?.config.model).toBe("m");
    await open({ request: { agentId: "a1", workspaceId: null, provider: "claude", cwd: "/x", reason: "create", purpose: "interactive", env } });

    await expect(create(request(env), ctx("running"))).rejects.toThrow(/Role "r" is at its limit of 1 concurrent agent/);
    // once the agent is idle, a new one may start
    expect((await create(request(env), ctx("idle")))?.config.model).toBe("m");
  });

  it("does not track or limit roles without maxConcurrent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hook-"));
    await writeFile(path.join(dir, "r.yaml"), "name: r\n");
    const limits = new RoleLimits(path.join(dir, "agents.json"));
    const create = agentCreateHook(async () => [dir], limits);
    for (let i = 0; i < 3; i++) expect(await create(request({ PASEO_AGENT_ROLE: "r" }), ctx("running"))).toBeDefined();
  });

  it("session open without a role does nothing", async () => {
    const limits = new RoleLimits(path.join(await mkdtemp(path.join(tmpdir(), "hook-")), "agents.json"));
    expect(await sessionOpenHook(limits)({ request: { agentId: "a", workspaceId: null, provider: "p", cwd: "/", reason: "create", purpose: "interactive", env: {} } })).toBeUndefined();
  });
});

describe("plugin entry", () => {
  it("registers the hook and cleans up", () => {
    const names: string[] = [];
    const cleanup = contribute({
      handle() {},
      registerSettings: () => ({ read: async () => ({ status: "ready", values: { sources: [] } }), subscribe: () => () => {} }),
      before(name: string) {
        names.push(name);
        return () => {};
      },
    } as never);
    expect(names).toEqual(["agent.create", "agent.session_open"]);
    cleanup();
  });
});
