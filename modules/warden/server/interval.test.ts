import { describe, expect, it } from "vitest";
import { parseInterval } from "./interval";

describe("parseInterval", () => {
  it("reads bare numbers as seconds", () => {
    expect(parseInterval("900")).toBe(15);
    expect(parseInterval("90")).toBe(2);
  });
  it("reads duration strings", () => {
    expect(parseInterval("15m")).toBe(15);
    expect(parseInterval("1h30m")).toBe(90);
    expect(parseInterval("2H")).toBe(120);
    expect(parseInterval(" 30s ")).toBe(1);
  });
  it("clamps to 1 minute..24 h", () => {
    expect(parseInterval("5s")).toBe(1);
    expect(parseInterval("3d")).toBe(1440);
  });
  it("rejects garbage and zero", () => {
    for (const bad of ["", "soon", "15 minutes", "-5m", "0", "m15"]) expect(() => parseInterval(bad)).toThrow(/PASEO_WARDEN_INTERVAL/);
  });
});
