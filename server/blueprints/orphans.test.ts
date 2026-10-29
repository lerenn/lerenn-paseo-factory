import { afterEach, describe, expect, it } from "vitest";
import { agentlessWorkspaces } from "./orphans";
import { setTrustedLabels } from "../trust";

const ws = (id: string, projectId = "p1") => ({ id, title: id, projectId, projectRootPath: `/r/${projectId}` });
const base = { known: new Set(["a", "b", "c"]), pmAgentIds: new Set<string>() };

describe("agentlessWorkspaces", () => {
  it("takes a workspace a Factory run knows with no agent, whatever its title", () => {
    const out = agentlessWorkspaces([ws("a"), ws("b"), ws("c")], [{ workspaceId: "b", status: "idle" }], base);
    expect(out.map((w) => w.id)).toEqual(["a", "c"]);
  });

  it("counts archived agents as gone but a closed (resumable) agent still holds its workspace", () => {
    const out = agentlessWorkspaces([ws("a"), ws("b")], [{ workspaceId: "a", status: "closed" }, { workspaceId: "b", archivedAt: "2026-10-28" }], base);
    expect(out.map((w) => w.id)).toEqual(["b"]);
  });

  it("never takes a workspace no Factory run knows, even in the same project with no agent", () => {
    const out = agentlessWorkspaces([ws("x"), ws("a")], [], base);
    expect(out.map((w) => w.id)).toEqual(["a"]);
  });

  it("never takes the PM's or the Assistant's workspace, even with the agent closed, nor a protected one", () => {
    const agents = [
      { id: "pm1", workspaceId: "a", status: "closed" },
      { id: "as", workspaceId: "b", status: "closed", labels: { "paseo.assistant": "1" } },
    ];
    expect(agentlessWorkspaces([ws("a"), ws("b"), ws("c")], agents, { ...base, pmAgentIds: new Set(["pm1"]), protect: new Set(["c"]) })).toEqual([]);
  });

  afterEach(() => setTrustedLabels([]));
  it("keeps the workspace of an agent with a trusted label, even archived, only when the label is trusted", () => {
    const agents = [{ id: "as", workspaceId: "b", archivedAt: "2026-10-28", labels: { "paseo.assistant": "1" } }];
    expect(agentlessWorkspaces([ws("b")], agents, base).map((w) => w.id)).toEqual(["b"]);
    setTrustedLabels(["paseo.assistant=1"]);
    expect(agentlessWorkspaces([ws("b")], agents, base)).toEqual([]);
  });
});
