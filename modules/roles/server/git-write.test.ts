import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSourceSchema } from "../shared/settings";
import { GitSources } from "./git-sync";
import { NothingToCommit, writeChange } from "./git-write";
import { git, makeOrigin, tmp } from "./testing";

async function setup(over: Record<string, unknown> = {}) {
  const origin = await makeOrigin();
  const sources = new GitSources(await tmp());
  const source = gitSourceSchema.parse({ url: origin.bare, ref: "main", path: "roles", ...over });
  await sources.sync(source);
  const cached = (file: string) => path.join(sources.rolesDir(source), file);
  const onMain = (file: string) => git(origin.bare, "show", `main:${file}`);
  return { origin, sources, source, cached, onMain };
}
const NOW = () => new Date("2026-10-23T12:34:56Z");

describe("writeChange", () => {
  it("pull-request mode pushes a branch and leaves main and the local copy alone", async () => {
    const { origin, sources, source, cached, onMain } = await setup();
    const r = await writeChange(sources, source, { name: "ev", text: "name: ev\nmodel: v2" }, NOW);
    expect(r).toMatchObject({
      outcome: "branch",
      action: "update",
      branch: "agents-roles/ev-20261023123456",
      base: "main",
      message: "agents-roles: update ev",
      files: ["roles/ev.yaml"],
    });
    expect(git(origin.bare, "show", `${r.branch}:roles/ev.yaml`)).toContain("v2");
    expect(onMain("roles/ev.yaml")).toContain("v1");
    expect(await readFile(cached("ev.yaml"), "utf8")).toContain("v1");
    expect(git(origin.bare, "log", "-1", "--format=%s", r.branch!).trim()).toBe("agents-roles: update ev");
  });

  it("push mode commits to the ref", async () => {
    const { origin, sources, source, onMain } = await setup({ writeMode: "push" });
    const r = await writeChange(sources, source, { name: "fresh", text: "name: fresh" }, NOW);
    expect(r).toMatchObject({ outcome: "pushed", action: "create", message: "agents-roles: create fresh" });
    expect(onMain("roles/fresh.yaml")).toBe("name: fresh\n");
    expect(git(origin.bare, "rev-parse", "main").trim()).toBe(r.commit);
  });

  it("falls back to a branch when push is rejected", async () => {
    const { origin, sources, source, onMain } = await setup({ writeMode: "push" });
    origin.protectMain();
    const r = await writeChange(sources, source, { name: "ev", text: "name: ev\nmodel: v3" }, NOW);
    expect(r.outcome).toBe("branch");
    expect(r.fellBack).toMatch(/protected branch|rejected|failed/i);
    expect(onMain("roles/ev.yaml")).toContain("v1");
    expect(git(origin.bare, "show", `${r.branch}:roles/ev.yaml`)).toContain("v3");
  });

  it("applies on top of upstream changes made after the last sync", async () => {
    const { origin, sources, source, onMain } = await setup({ writeMode: "push" });
    await origin.upstream("roles/other.yaml", "name: other\n");
    await writeChange(sources, source, { name: "ev", text: "name: ev\nmodel: v4" }, NOW);
    expect(onMain("roles/other.yaml")).toBe("name: other\n");
    expect(onMain("roles/ev.yaml")).toContain("v4");
  });

  it("deletes a role", async () => {
    const { sources, source, cached, onMain } = await setup({ writeMode: "push" });
    const r = await writeChange(sources, source, { name: "ev", delete: true }, NOW);
    expect(r).toMatchObject({ action: "delete", message: "agents-roles: delete ev" });
    expect(() => onMain("roles/ev.yaml")).toThrow();
    expect(existsSync(cached("ev.yaml"))).toBe(false);
    await expect(writeChange(sources, source, { name: "ev", delete: true }, NOW)).rejects.toThrow(/No role/);
  });

  it("reports nothing to commit for identical content", async () => {
    const { sources, source } = await setup();
    await expect(writeChange(sources, source, { name: "ev", text: "name: ev\nmodel: v1" }, NOW)).rejects.toBeInstanceOf(
      NothingToCommit,
    );
  });

  it("keeps the edit unsaved and the cache clean when the remote is unreachable", async () => {
    const { origin, sources, source, cached } = await setup();
    await rm(origin.bare, { recursive: true });
    await expect(writeChange(sources, source, { name: "ev", text: "name: ev\nmodel: x" }, NOW)).rejects.toThrow();
    expect(await readFile(cached("ev.yaml"), "utf8")).toContain("v1");
    expect(git(sources.cacheDir(source), "status", "--porcelain").trim()).toBe("");
  });

  it("refuses to write when the ref is not a branch", async () => {
    const origin = await makeOrigin();
    git(origin.work, "tag", "v1");
    git(origin.work, "push", "-q", "origin", "v1");
    const sources = new GitSources(await tmp());
    const source = gitSourceSchema.parse({ url: origin.bare, ref: "v1", path: "roles" });
    await sources.sync(source);
    await expect(writeChange(sources, source, { name: "ev", text: "name: ev" }, NOW)).rejects.toThrow(/not a branch/);
  });

  it("uses the repository's default branch when no ref is set", async () => {
    const origin = await makeOrigin();
    const sources = new GitSources(await tmp());
    const source = gitSourceSchema.parse({ url: origin.bare, path: "roles", writeMode: "push" });
    await sources.sync(source);
    const r = await writeChange(sources, source, { name: "n", text: "name: n" }, NOW);
    expect(r.base).toBe("main");
    expect(git(origin.bare, "show", "main:roles/n.yaml")).toBe("name: n\n");
  });
});
