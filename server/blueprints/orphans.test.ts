import { describe, expect, it } from "vitest";
import { agentlessWorkspaces } from "./orphans";

describe("agentlessWorkspaces", () => {
  const ws = [
    { id: "w1", title: "Implementer: ANY-1 fix" },
    { id: "w2", title: "PR Babysitter: ANY-2" },
    { id: "w3", title: "My own checkout" },
    { id: "w4", title: "QA: ANY-3" },
  ];
  it("archives a Factory workspace only on its second agentless sweep, never one with a live agent or another title", () => {
    const first = agentlessWorkspaces(ws, new Set(["w4"]), ["implementer", "pr-babysitter", "qa"], new Set());
    expect([...first.seen]).toEqual(["w1", "w2"]);
    expect(first.archive).toEqual([]);
    const second = agentlessWorkspaces(ws, new Set(["w4", "w2"]), ["implementer", "pr-babysitter", "qa"], first.seen);
    expect(second.archive.map((w) => w.id)).toEqual(["w1"]);
  });
});
