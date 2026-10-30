import { afterEach, describe, expect, it } from "vitest";
import { flakeReason, isStartFailure, retroFlake, SESSION_GONE, setFlakePatterns } from "./flake";
import { DEFAULT_FLAKE_PATTERNS, DEFAULT_RETRO_FLAKE_PATTERNS, settingsSchema } from "../../shared/blueprints/settings";

afterEach(() => setFlakePatterns(null));

describe("flake patterns", () => {
  it("default to today's Kubernetes patterns, the same as an unset setting", () => {
    const parsed = settingsSchema.parse({}).flakes;
    expect(parsed).toEqual({ patterns: DEFAULT_FLAKE_PATTERNS, retroPatterns: DEFAULT_RETRO_FLAKE_PATTERNS });
    setFlakePatterns(parsed);
    expect(flakeReason("Claude Code process exited with code 137")).toBe("OOMKilled / exit 137");
    expect(flakeReason("kube: could not start the pod: boom")).toBe("pod did not start");
    expect(isStartFailure("pod did not start")).toBe(true);
    expect(isStartFailure("OOMKilled / exit 137")).toBe(false);
    expect(retroFlake("Warning FailedScheduling 0/3 nodes")).toBe("FailedScheduling");
  });

  it("the start failures are today's four", () => {
    expect(DEFAULT_FLAKE_PATTERNS.filter((p) => p.startFailure).map((p) => p.label).sort()).toEqual(["bridge.mjs not written", "container not found", "pod did not start", "pod not ready"]);
  });

  it("a setting replaces them, case-insensitively; the gone provider session stays built in", () => {
    setFlakePatterns({ patterns: [{ pattern: "vm (crashed|lost)", label: "vm lost", startFailure: true }], retroPatterns: ["vm crashed", "quota"] });
    expect(flakeReason("VM Crashed at 12:00")).toBe("vm lost");
    expect(flakeReason("exit code 137")).toBeNull();
    expect(flakeReason("No conversation found with session ID abc")).toBe(SESSION_GONE);
    expect(isStartFailure("vm lost")).toBe(true);
    expect(isStartFailure("pod did not start")).toBe(false);
    expect(retroFlake("the vm crashed")).toBe("vm crashed");
    expect(retroFlake("OOMKilled")).toBeNull();
  });

  it("empty lists switch flakes off (except a gone session)", () => {
    setFlakePatterns({ patterns: [], retroPatterns: [] });
    expect(flakeReason("OOMKilled")).toBeNull();
    expect(retroFlake("OOMKilled")).toBeNull();
  });

  it("the setting refuses a pattern that is not a regular expression", () => {
    expect(settingsSchema.safeParse({ flakes: { patterns: [{ pattern: "(", label: "x" }] } }).success).toBe(false);
    expect(settingsSchema.safeParse({ flakes: { retroPatterns: ["["] } }).success).toBe(false);
  });

  it("a bad pattern that got through is skipped, the others still work", () => {
    setFlakePatterns({ patterns: [{ pattern: "(", label: "bad", startFailure: false }, { pattern: "boom", label: "boom", startFailure: false }], retroPatterns: ["(", "boom"] });
    expect(flakeReason("boom")).toBe("boom");
    expect(retroFlake("boom")).toBe("boom");
  });
});
