import { describe, expect, it } from "vitest";
import { scopeApplies } from "./inject";

describe("scopeApplies", () => {
  it("honours off, on and the scope", () => {
    expect(scopeApplies("all", {})).toBe(true);
    expect(scopeApplies("all", { PASEO_LEASES: "off" })).toBe(false);
    expect(scopeApplies("opt-in", {})).toBe(false);
    expect(scopeApplies("opt-in", { PASEO_LEASES: "on" })).toBe(true);
  });
});
