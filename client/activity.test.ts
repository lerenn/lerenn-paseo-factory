import { describe, expect, it } from "vitest";
import { filterActivity } from "./activity-filter";

const item = (over: object) => ({ at: 1, type: "run", title: "t", detail: null, blueprint: null, role: null, link: null, ...over }) as never;

describe("filterActivity", () => {
  const items = [item({ type: "run", blueprint: "ticket" }), item({ type: "escalation", blueprint: "ticket", role: "implementer" }), item({ type: "lease" })];
  it("empty filters keep everything; each filter narrows", () => {
    expect(filterActivity(items, { types: [], blueprint: null, role: null })).toHaveLength(3);
    expect(filterActivity(items, { types: ["run", "lease"], blueprint: null, role: null })).toHaveLength(2);
    expect(filterActivity(items, { types: [], blueprint: "ticket", role: null })).toHaveLength(2);
    expect(filterActivity(items, { types: [], blueprint: "ticket", role: "implementer" })).toHaveLength(1);
  });
});
