import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Paseo's plugin loader only accepts source under client/, server/ and shared/ (plus the two entry files).
// The loader's own validator is not available to CI, so this test mimics it.
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const SOURCE = /\.(ts|tsx)$/;
const ENTRY = /^index\.(server|client)(\.test)?\.tsx?$/;

describe("plugin layout", () => {
  it("keeps every source file under client/, server/ or shared/ (or an entry file)", () => {
    const stray = tracked.filter((f) => SOURCE.test(f) && !ENTRY.test(f) && !/^(client|server|shared|\.dagger)\//.test(f) && !/^(layout\.test|vitest\.config)\.ts$/.test(f));
    expect(stray).toEqual([]);
  });

  it("has no other top-level folder (modules/, lib/, ...)", () => {
    const dirs = readdirSync(".", { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(["client", "server", "shared"]);
  });

  it("client code does not import server code, and shared code imports neither", () => {
    const bad = tracked
      .filter((f) => /^(client|shared)\/.*\.tsx?$/.test(f) && !f.endsWith(".test.ts"))
      .filter((f) => {
        const text = execFileSync("cat", [f], { encoding: "utf8" });
        const re = f.startsWith("client/") ? /from "(\.\.\/)+server\// : /from "(\.\.\/)+(server|client)\//;
        return re.test(text) || /from "node:/.test(text) && f.startsWith("client/");
      });
    expect(bad).toEqual([]);
  });
});
