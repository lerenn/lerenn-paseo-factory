import { describe, expect, it } from "vitest";
import { roleAgents } from "./agents";

describe("roleAgents", () => {
  const workspaces = [{ id: "w", projectDisplayName: "Proj", title: "Branch" }];
  it("keeps live agents with a role (registry first, then the Factory label) and their run", () => {
    const out = roleAgents(
      [
        { id: "a", title: "A", status: "running", workspaceId: "w", labels: { "paseo.factory.run": "bp-1", "paseo.factory.blueprint": "ticket", "paseo.factory.stage": "implement", "paseo.factory.role": "implementer" } },
        { id: "b", title: "B", status: "idle", workspaceId: null },
        { id: "c", title: "C", status: "idle", workspaceId: null, labels: { "paseo.factory.role": "qa" } },
        { id: "d", title: "D", status: "idle", workspaceId: null, archivedAt: "2026-01-01" },
        { id: "e", title: "E", status: "closed", workspaceId: null, labels: { "paseo.factory.role": "qa" } },
      ],
      { b: "reviewer", d: "reviewer" },
      workspaces,
    );
    expect(out.map((x) => [x.id, x.role])).toEqual([["a", "implementer"], ["c", "qa"], ["b", "reviewer"]]);
    expect(out[0]).toMatchObject({ run: "bp-1", blueprint: "ticket", stage: "implement", workspaceName: "Branch", projectName: "Proj" });
  });
});
