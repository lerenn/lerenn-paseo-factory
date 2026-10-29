import { afterEach, describe, expect, it } from "vitest";
import { agentlessWorkspaces, factoryWorkspaceTitles } from "./orphans";
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

describe("agentlessWorkspaces: workspaces whose agent never came", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const min = 60_000;

  it("takes a workspace the Factory recorded creating with no agent, once the grace has passed", () => {
    const created = new Map([["new", now - 2 * min], ["old", now - 11 * min]]);
    const out = agentlessWorkspaces([ws("new"), ws("old")], [], { ...base, created, now });
    expect(out.map((w) => w.id)).toEqual(["old"]);
  });

  it("takes a recorded workspace whose agent was archived, and keeps one with a live agent", () => {
    const created = new Map([["d", now - 30 * min], ["e", now - 30 * min]]);
    const agents = [{ id: "x", workspaceId: "d", archivedAt: "2026-10-29" }, { id: "y", workspaceId: "e", status: "idle" }];
    expect(agentlessWorkspaces([ws("d"), ws("e")], agents, { ...base, created, now }).map((w) => w.id)).toEqual(["d"]);
  });

  it("takes an unrecorded workspace by its Factory title (a leak from before the record), after the grace", () => {
    const titles = new Set(["Implementer: ANY-2747 Fix it"]);
    const leak = { ...ws("l1"), title: "Implementer: ANY-2747 Fix it", statusEnteredAt: new Date(now - 60 * min).toISOString() };
    const young = { ...ws("l2"), title: "Implementer: ANY-2747 Fix it", statusEnteredAt: new Date(now - min).toISOString() };
    const other = { ...ws("l3"), title: "Implementer: ANY-9 Other" };
    expect(agentlessWorkspaces([leak, young, other], [], { ...base, titles, now }).map((w) => w.id)).toEqual(["l1"]);
  });

  it("keeps the protections: shared run workspace, trusted label, PM, and one being archived", () => {
    setTrustedLabels(["paseo.assistant=1"]);
    const created = new Map(["s", "t", "p", "z"].map((id) => [id, now - 60 * min] as [string, number]));
    const agents = [
      { id: "as", workspaceId: "t", archivedAt: "2026-10-29", labels: { "paseo.assistant": "1" } },
      { id: "pm1", workspaceId: "p", status: "closed" },
    ];
    const list = [ws("s"), ws("t"), ws("p"), { ...ws("z"), archivingAt: "2026-10-29" }];
    expect(agentlessWorkspaces(list, agents, { ...base, created, now, pmAgentIds: new Set(["pm1"]), protect: new Set(["s"]) })).toEqual([]);
    setTrustedLabels([]);
  });
});

describe("factoryWorkspaceTitles", () => {
  it("gives the titles the Factory sets for each agent stage's role and the PM", () => {
    const runs = [{ id: "bp-1", blueprint: "ship", vars: { ticket: "ANY-2747", ticket_title: "Fix it" }, def: { stage: [{ id: "implement", role: "implementer" }, { id: "gate", kind: "gate" }] } }];
    expect([...factoryWorkspaceTitles(runs, "pm")].sort()).toEqual(["Implementer: ANY-2747 Fix it", "PM: ANY-2747 Fix it"]);
  });
});
