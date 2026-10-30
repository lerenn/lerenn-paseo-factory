import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_TTL_MS, KnownExtensions, placeholderTools } from "./known-extensions";

describe("known extensions", () => {
  it("remembers each extension's tools on disk and forgets one that stopped registering a week ago", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "known-")), "extensions.json");
    let now = 1_000;
    const a = new KnownExtensions(file, () => now);
    a.remember("lanes", [{ name: "lanes_board", description: "d", inputSchema: { type: "object" }, readOnly: true }]);
    expect(new KnownExtensions(file, () => now).tools("lanes")).toEqual([{ name: "lanes_board", description: "d", inputSchema: { type: "object" }, readOnly: true }]);
    now += KNOWN_TTL_MS + 1;
    expect(new KnownExtensions(file, () => now).ids()).toEqual([]);
  });

  it("serves placeholders that keep the access hints and ask to retry", () => {
    const [t] = placeholderTools("lanes", [{ name: "lanes_board", description: "d", inputSchema: { type: "object" }, readOnly: true }]);
    expect(t).toMatchObject({ name: "lanes_board", readOnly: true, extension: true, jsonSchema: { type: "object" } });
    expect(() => t!.run({}, {} as never)).toThrow(/not connected to the Factory right now/);
    const [w] = placeholderTools("lanes", [{ name: "lanes_unblock", description: "d", inputSchema: { type: "object" }, trustedWrite: true }]);
    expect(w).toMatchObject({ name: "lanes_unblock", trustedWrite: true, extension: true });
  });
});
