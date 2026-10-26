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

  it("slugs obey Paseo's rule", () => {
    expect(slugFor("Supervisor", "ab12")).toBe("supervisor-ab12");
    expect(slugFor("PR Babysitter: ANY-1 Très long titre !!!", "ab12")).toMatch(/^[a-z0-9][a-z0-9-]*-ab12$/);
    expect(slugFor("???", "ab12")).toBe("factory-ab12");
  });
});
