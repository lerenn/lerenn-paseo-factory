import { describe, expect, it } from "vitest";
import { resolveLink } from "./extension-link";

describe("resolveLink", () => {
  it("opens a run on the Blueprints tab and an item on the Inbox tab", () => {
    expect(resolveLink({ tab: "blueprints", runId: "r1" })).toEqual({ tab: "blueprints", focus: "r1" });
    expect(resolveLink({ tab: "inbox", itemId: "i1" })).toEqual({ tab: "inbox", focus: "i1" });
  });

  it("opens only http(s) URLs", () => {
    expect(resolveLink({ url: "https://tracker.example/issue/ABC-1" })).toEqual({ url: "https://tracker.example/issue/ABC-1" });
    expect(resolveLink({ url: "javascript:alert(1)" })).toBeNull();
  });

  it("ignores other tabs and empty ids", () => {
    expect(resolveLink({ tab: "leases", runId: "r1" } as never)).toBeNull();
    expect(resolveLink({ tab: "blueprints", runId: "" })).toBeNull();
    expect(resolveLink(null)).toBeNull();
  });
});
