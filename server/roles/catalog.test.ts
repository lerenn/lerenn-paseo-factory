import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listRoles, type GitLayer } from "./catalog";

const tmp = () => mkdtemp(path.join(tmpdir(), "catalog-"));
const layer = async (label: string, files: Record<string, string> = {}): Promise<GitLayer> => {
  const dir = await tmp();
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  return { id: label, label: `git: ${label}@main`, dir };
};

describe("role catalog", () => {
  it("is empty with no git sources, or when their folders are empty or missing", async () => {
    expect(await listRoles([])).toEqual([]);
    expect(await listRoles([await layer("a")])).toEqual([]);
    expect(await listRoles([{ id: "x", label: "x", dir: path.join(await tmp(), "missing") }])).toEqual([]);
  });

  it("lists roles with their source and an earlier source winning a name clash", async () => {
    const a = await layer("a", { "qa.yaml": "name: qa\nmodel: a\n", "only-a.yaml": "name: only-a\n" });
    const b = await layer("b", { "qa.yaml": "name: qa\nmodel: b\n", "only-b.json": JSON.stringify({ name: "only-b" }) });
    const roles = await listRoles([a, b]);
    expect(roles.map((r) => r.name)).toEqual(["only-a", "only-b", "qa"]);
    const qa = roles.find((r) => r.name === "qa");
    expect(qa).toMatchObject({ sourceId: "a", origin: "git: a@main", overrides: ["git: b@main"] });
    expect(qa?.role?.model).toBe("a");
  });

  it("surfaces invalid files instead of hiding them, and ignores other files", async () => {
    const a = await layer("a", { "bad.yaml": "name: bad\nnope: 1\n", "Not Valid.yaml": "name: x\n", "README.md": "hi" });
    await mkdir(path.join(a.dir, "sub"));
    const roles = await listRoles([a]);
    expect(roles.map((r) => r.name)).toEqual(["bad"]);
    expect(roles[0].error).toMatch(/nope|Unrecognized/);
  });
});
