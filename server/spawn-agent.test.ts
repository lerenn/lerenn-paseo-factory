import { describe, expect, it, vi } from "vitest";
import { slugFor, spawnAgent } from "./spawn-agent";

const input = { idempotencyKey: "run1:think:1:1", config: { provider: "claude/x" }, cwd: "/repo", title: "agent", workspaceTitle: "Investigator: ANY-1 Fix it", prompt: "go", labels: { "paseo.factory": "1" }, env: { A: "1" } };

function fakePaseo() {
  const wsCreate = vi.fn(async (_o: unknown) => ({ id: "ws1", agents: { create: vi.fn(async (_a: unknown) => ({ id: "ag-pod" })) } }));
  const agentCreate = vi.fn(async (_a: unknown) => ({ id: "ag-local" }));
  const paseo = {
    workspaces: { create: wsCreate, ref: () => ({ refresh: async () => ({ title: "x" }), setTitle: async () => ({ title: null }) }) },
    agents: { create: agentCreate, ref: () => ({ refresh: async () => ({ agent: { workspaceId: "ws1" } }) }) },
  };
  return { paseo, wsCreate, agentCreate };
}

describe("spawnAgent", () => {
  it("kubernetes: creates a pod workspace with the runtime options, then the agent in it", async () => {
    const { paseo, wsCreate, agentCreate } = fakePaseo();
    const out = await spawnAgent(paseo as never, "kubernetes", input);
    expect(out).toEqual({ agentId: "ag-pod", workspaceId: "ws1" });
    const req = wsCreate.mock.calls[0][0] as any;
    expect(req.source).toEqual({ kind: "directory", path: "/repo" });
    expect(req.title).toBe("Investigator: ANY-1 Fix it");
    expect(req.runtime.id).toBe("kubernetes");
    expect(req.runtime.options).toMatchObject({ cwd: "/repo", ref: null, title: "Investigator: ANY-1 Fix it" });
    expect(req.runtime.options.slug).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/);
    expect(agentCreate).not.toHaveBeenCalled();
  });

  it("local: creates the agent on the daemon and titles its workspace", async () => {
    const { paseo, wsCreate, agentCreate } = fakePaseo();
    const out = await spawnAgent(paseo as never, "local", input);
    expect(out.agentId).toBe("ag-local");
    expect(wsCreate).not.toHaveBeenCalled();
    expect(agentCreate.mock.calls[0][0]).toMatchObject({ cwd: "/repo", labels: { "paseo.factory": "1" }, env: { A: "1" } });
  });

  it("kubernetes: archives the workspace it created when the agent cannot be created, and rethrows the original error", async () => {
    const archive = vi.fn(async (_id: string) => ({ error: null }));
    const created: string[] = [];
    const refused = new Error("Plugin paseo-factory agent.create.before failed: Role implementer is at its limit of 6 concurrent agents");
    const paseo = {
      workspaces: { archive, create: vi.fn(async () => ({ id: "ws9", agents: { create: vi.fn(async () => Promise.reject(refused)) } })) },
      agents: {},
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(spawnAgent(paseo as never, "kubernetes", { ...input, onWorkspaceCreated: (id) => created.push(id) })).rejects.toBe(refused);
    expect(archive).toHaveBeenCalledWith("ws9");
    expect(created).toEqual(["ws9"]);
    expect(log.mock.calls.some(([l]) => String(l).includes("archived workspace ws9"))).toBe(true);
    log.mockRestore();
  });

  it("kubernetes: a failing archive never masks the original error", async () => {
    const refused = new Error("at its limit");
    const paseo = {
      workspaces: { archive: vi.fn(async () => Promise.reject(new Error("daemon down"))), create: vi.fn(async () => ({ id: "ws9", agents: { create: vi.fn(async () => Promise.reject(refused)) } })) },
      agents: {},
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(spawnAgent(paseo as never, "kubernetes", input)).rejects.toBe(refused);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("kubernetes: never archives a joined workspace when the agent cannot be created in it", async () => {
    const archive = vi.fn(async () => ({ error: null }));
    const paseo = { workspaces: { archive, ref: () => ({ agents: { create: async () => Promise.reject(new Error("gone")) } }) }, agents: {} };
    await expect(spawnAgent(paseo as never, "kubernetes", { ...input, joinWorkspaceId: "shared" })).rejects.toThrow("gone");
    expect(archive).not.toHaveBeenCalled();
  });

  it("slugs obey Paseo's rule", () => {
    expect(slugFor("Supervisor", "ab12")).toBe("supervisor-ab12");
    expect(slugFor("PR Babysitter: ANY-1 Très long titre !!!", "ab12")).toMatch(/^[a-z0-9][a-z0-9-]*-ab12$/);
    expect(slugFor("???", "ab12")).toBe("factory-ab12");
  });
});
