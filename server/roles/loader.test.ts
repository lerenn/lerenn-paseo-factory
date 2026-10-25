import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRole } from "./loader";

const tmp = () => mkdtemp(path.join(tmpdir(), "roles-"));

describe("loadRole", () => {
  it("reads YAML and JSON role files", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "a.yaml"), "name: a\nmodel: m1\nenv:\n  PASEO_KUBE_TEMPLATE: t\n");
    await writeFile(path.join(dir, "b.json"), JSON.stringify({ name: "b", model: "m2" }));
    expect(await loadRole("a", [dir])).toMatchObject({ model: "m1", env: { PASEO_KUBE_TEMPLATE: "t" } });
    expect(await loadRole("b", [dir])).toMatchObject({ model: "m2", version: 1 });
  });

  it("prefers earlier directories", async () => {
    const first = await tmp();
    await writeFile(path.join(first, "reviewer.yml"), "name: reviewer\nmodel: custom\n");
    expect((await loadRole("reviewer", [first]))?.model).toBe("custom");
    expect(await loadRole("reviewer", [await tmp()])).toBeNull();
  });

  it("returns null for an unknown role", async () => {
    expect(await loadRole("nope", [await tmp()])).toBeNull();
  });

  it("rejects names that could escape the directory", async () => {
    await expect(loadRole("../x", [await tmp()])).rejects.toThrow();
  });

  it("reports invalid files with their path", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "bad.yaml"), "name: bad\nunknownField: 1\n");
    await writeFile(path.join(dir, "mismatch.yaml"), "name: other\n");
    await expect(loadRole("bad", [dir])).rejects.toThrow(/bad\.yaml/);
    await expect(loadRole("mismatch", [dir])).rejects.toThrow(/must match the file name/);
  });
});

describe("example roles", () => {
  it("are valid role files and are never loaded by default", async () => {
    const dir = path.join(__dirname, "..", "..", "shared", "examples", "roles");
    for (const name of ["babysitter", "implementer", "investigator", "qa", "reviewer"]) {
      expect((await loadRole(name, [dir]))?.name).toBe(name);
    }
  });
});
