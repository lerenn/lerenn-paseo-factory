import { describe, expect, it } from "vitest";
import { buildActivity } from "./activity";

const run: any = {
  id: "bp-1",
  blueprint: "ticket",
  vars: { ticket: "ABC-1" },
  def: { stage: [{ id: "implement", role: "implementer" }] },
  history: [
    { at: 1, event: "started", stage: "investigate", detail: "by pm" },
    { at: 2, event: "enter", stage: "implement", detail: "agent run 1" },
    { at: 3, event: "spawned", stage: "implement", detail: "x" },
    { at: 4, event: "exhausted", stage: "implement", detail: "3 attempts used" },
    { at: 9, event: "merged", stage: "merge", detail: null },
  ],
};

describe("activity", () => {
  it("merges runs, inbox, leases and extension events, newest first, with roles and links", () => {
    const items = buildActivity({
      runs: [run],
      inbox: [{ at: 5, itemId: "i1", type: "answered", actor: "assistant on behalf of the user", detail: "approve" }, { at: 5, itemId: "i1", type: "delivered", actor: "system", detail: null }],
      leases: [{ at: 6, lease: "pr:a/b#1@abc", type: "acquired", actor: "agent-1", detail: null }, { at: 6, lease: "x", type: "renewed", actor: "a", detail: null }],
      extensions: [{ at: 8, extension: "shipit", type: "deploy", title: "prd deploy of backend v1.2.3" }],
    });
    expect(items.map((i) => [i.at, i.type])).toEqual([[9, "merge"], [8, "deploy"], [6, "lease"], [5, "inbox"], [4, "escalation"], [2, "stage"], [1, "run"]]);
    const stage = items.find((i) => i.type === "stage")!;
    expect(stage).toMatchObject({ blueprint: "ticket", role: "implementer", link: { tab: "blueprints", id: "bp-1" } });
    expect(items.find((i) => i.type === "deploy")!.link).toEqual({ tab: "ext:shipit", id: "" });
    expect(items.map((i) => [i.type, i.tone])).toContainEqual(["merge", "success"]);
    expect(items.map((i) => [i.type, i.tone])).toContainEqual(["escalation", "warning"]);
    expect(items.find((i) => i.type === "deploy")!.tone).toBeNull(); // no built-in deploy: the extension names its tone
  });

  it("keeps an extension's own type and tone; a malformed type or a Factory kind other than merge shows as extension", () => {
    const ext = (type: string, tone?: string) => ({ at: 1, extension: "x", type, tone, title: type });
    const items = buildActivity({ runs: [], inbox: [], leases: [], extensions: [ext("release", "success"), ext("Bad Type!"), ext("gate"), ext("merge"), ext("deploy", "loud")] });
    expect(items.map((i) => [i.title, i.type, i.tone])).toEqual([
      ["release", "release", "success"],
      ["Bad Type!", "extension", null],
      ["gate", "extension", null],
      ["merge", "merge", "success"],
      ["deploy", "deploy", null],
    ]);
  });

  it("caps the list", () => {
    const many = { ...run, history: Array.from({ length: 50 }, (_, i) => ({ at: i, event: "enter", stage: "implement", detail: null })) };
    expect(buildActivity({ runs: [many], inbox: [], leases: [], extensions: [], limit: 10 })).toHaveLength(10);
  });
});
