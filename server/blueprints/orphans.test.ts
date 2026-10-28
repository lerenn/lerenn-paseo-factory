import { describe, expect, it } from "vitest";
import { agentlessWorkspaces } from "./orphans";

const ws = (id: string, projectId = "p1") => ({ id, title: id, projectId, projectRootPath: `/r/${projectId}` });
const base = { projects: new Set(["p1"]), roots: new Set<string>(), pmAgentIds: new Set<string>() };

describe("agentlessWorkspaces", () => {
  it("takes a workspace of a Factory project with no live agent, whatever its title", () => {
    const out = agentlessWorkspaces([ws("a"), ws("b"), ws("c")], [{ workspaceId: "b", status: "idle" }], base);
    expect(out.map((w) => w.id)).toEqual(["a", "c"]);
  });

  it("counts closed and archived agents as gone", () => {
    const out = agentlessWorkspaces([ws("a"), ws("b")], [{ workspaceId: "a", status: "closed" }, { workspaceId: "b", archivedAt: "2026-10-28" }], base);
    expect(out.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("leaves other projects alone, and matches a project by its root", () => {
    const out = agentlessWorkspaces([ws("a", "p2"), ws("b", "p3")], [], { ...base, roots: new Set(["/r/p3"]) });
    expect(out.map((w) => w.id)).toEqual(["b"]);
  });

  it("never takes the PM's or the Assistant's workspace, even with the agent closed, nor a protected one", () => {
    const agents = [
      { id: "pm1", workspaceId: "a", status: "closed" },
      { id: "as", workspaceId: "b", status: "closed", labels: { "paseo.assistant": "1" } },
    ];
    expect(agentlessWorkspaces([ws("a"), ws("b"), ws("c")], agents, { ...base, pmAgentIds: new Set(["pm1"]), protect: new Set(["c"]) })).toEqual([]);
  });
});
