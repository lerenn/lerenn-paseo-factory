import { describe, expect, it } from "vitest";
import { badgeText, badgeTooltip, badgesFor } from "./agent-badge";

describe("agent badge", () => {
  it("shows blueprint and stage for a run agent", () => {
    const labels = { "paseo.factory": "1", "paseo.factory.blueprint": "ticket", "paseo.factory.stage": "implement", "paseo.factory.run": "bp-1", "paseo.factory.role": "implementer" };
    expect(badgeText(labels)).toBe("ticket · implement");
    expect(badgeTooltip(labels)).toBe("Factory run bp-1 · role implementer");
  });
  it("is icon only, with no '?' or 'factory', for the supervisor", () => {
    const labels = { "paseo.factory": "1", "paseo.factory.supervisor": "1", "paseo.factory.role": "supervisor" };
    expect(badgeText(labels)).toBe("");
    expect(badgeTooltip(labels)).toBe("Factory agent (supervisor)");
  });
  it("never prints placeholders for missing labels", () => {
    expect(badgeText({ "paseo.factory.stage": "think" })).toBe("think");
    expect(badgeTooltip({ "paseo.factory": "1" })).toBe("Factory agent");
  });

  it("every Factory agent gets exactly one badge: the Supervisor, a PM, a worker", () => {
    const supervisor = { "paseo.factory": "1", "paseo.factory.supervisor": "1", "paseo.factory.role": "supervisor" };
    const pm = { "paseo.factory": "1", "paseo.factory.run": "bp-1", "paseo.factory.role": "pm", "paseo.factory.stage": "pm", "paseo.factory.blueprint": "ticket" };
    expect(badgesFor(supervisor).map((b) => b.id)).toEqual(["factory-supervisor"]);
    expect(badgesFor(pm).map((b) => b.id)).toEqual(["factory-run"]);
    expect(badgesFor({}).length).toBe(0);
  });
});
