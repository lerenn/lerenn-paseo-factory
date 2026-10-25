import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBlueprint } from "./toml";

const dir = path.join(__dirname, "..", "..", "..", "docs", "examples", "blueprints");

describe("example blueprints", async () => {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".toml"));
  it.each(files)("%s is valid and named after its file", async (file) => {
    const { blueprint } = parseBlueprint(await readFile(path.join(dir, file), "utf8"));
    expect(blueprint.name).toBe(path.basename(file, ".toml"));
  });
});
