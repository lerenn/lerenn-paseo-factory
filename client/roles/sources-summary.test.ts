import { describe, expect, it } from "vitest";
import type { GitStatus } from "../../shared/roles/rpc";
import { sourcesSummary } from "./sources-summary";

const status = (label: string, error: string | null = null): GitStatus => ({
  id: label, label, url: label, writeMode: "pull-request", forge: null, hasToken: false, lastSync: null, error, syncing: false,
});

describe("sourcesSummary", () => {
  it("says when nothing is configured", () => {
    expect(sourcesSummary([])).toBe("No git source configured.");
  });
  it("lists sources and flags failing ones", () => {
    expect(sourcesSummary([status("a/b@main")])).toBe("1 source: a/b@main");
    expect(sourcesSummary([status("a/b@main"), status("c/d@v1", "boom")])).toBe("2 sources: a/b@main, c/d@v1 · 1 failing to sync");
  });
});
