import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBlueprint } from "./toml";

const dir = path.join(__dirname, "..", "..", "shared", "examples", "blueprints");

describe("example blueprints", async () => {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".toml"));
  it.each(files)("%s is valid and named after its file", async (file) => {
    const { blueprint } = parseBlueprint(await readFile(path.join(dir, file), "utf8"));
    expect(blueprint.name).toBe(path.basename(file, ".toml"));
  });

  it("the ticket blueprint's ask-blocked gate quotes the stage that sent the run there", async () => {
    const { blueprint } = parseBlueprint(await readFile(path.join(dir, "ticket.toml"), "utf8"));
    const gate = blueprint.stage.find((s) => s.id === "ask-blocked") as { question: string };
    expect(gate.question).toContain("{{from.summary}}");
    expect(gate.question).not.toContain("stage.implement");
  });
});
