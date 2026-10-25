import { describe, expect, it } from "vitest";
import { envValue, scopeApplies } from "./inject";

describe("scopeApplies", () => {
  it("scope all: everyone but PASEO_WARDEN=off", () => {
    expect(scopeApplies("all", undefined)).toBe(true);
    expect(scopeApplies("all", { PASEO_WARDEN: "on" })).toBe(true);
    expect(scopeApplies("all", { PASEO_WARDEN: "off" })).toBe(false);
  });
  it("scope opt-in: only PASEO_WARDEN=on", () => {
    expect(scopeApplies("opt-in", {})).toBe(false);
    expect(scopeApplies("opt-in", { PASEO_WARDEN: "on" })).toBe(true);
    expect(scopeApplies("opt-in", { PASEO_WARDEN: "off" })).toBe(false);
  });
});

describe("deprecated pre-rename env", () => {
  it("falls back to PASEO_WARDER*, the new name wins", () => {
    expect(scopeApplies("all", { PASEO_WARDER: "off" })).toBe(false);
    expect(scopeApplies("opt-in", { PASEO_WARDER: "on" })).toBe(true);
    expect(envValue({ PASEO_WARDER_INTERVAL: "5m" }, "PASEO_WARDEN_INTERVAL")).toBe("5m");
    expect(envValue({ PASEO_WARDER: "off", PASEO_WARDEN: "on" }, "PASEO_WARDEN")).toBe("on");
  });
});
