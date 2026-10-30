import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "./store";

describe("RunStore created workspaces", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("records a created workspace across restarts and forgets it", () => {
    dir = mkdtempSync(path.join(tmpdir(), "bp-store-"));
    const file = path.join(dir, "state.json");
    new RunStore(file).noteWorkspace("ws1", { at: 1, run: "bp-1", title: "Implementer: ABC-1" });
    const again = new RunStore(file);
    expect(again.createdWorkspaces()).toEqual({ ws1: { at: 1, run: "bp-1", title: "Implementer: ABC-1" } });
    again.forgetWorkspaces(["ws1", "nope"]);
    expect(new RunStore(file).createdWorkspaces()).toEqual({});
  });
});
