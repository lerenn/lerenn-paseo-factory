import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Blueprint } from "../../shared/blueprints/blueprint";
import { parseBlueprint } from "./toml";

export interface Catalog {
  blueprints: Map<string, { blueprint: Blueprint; sha: string; file: string; text: string; source: string }>;
  errors: { file: string; message: string }[];
}

/** Every `<name>.toml` in the folders, earlier folders winning. The file name must equal the blueprint name. */
export async function loadCatalog(folders: (string | { dir: string; label: string })[]): Promise<Catalog> {
  const catalog: Catalog = { blueprints: new Map(), errors: [] };
  for (const folder of folders) {
    const dir = typeof folder === "string" ? folder : folder.dir;
    const label = typeof folder === "string" ? dir : folder.label;
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".toml")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const text = await readFile(file, "utf8");
        const { blueprint, sha } = parseBlueprint(text);
        if (blueprint.name !== path.basename(name, ".toml")) throw new Error(`name "${blueprint.name}" must equal the file name`);
        if (!catalog.blueprints.has(blueprint.name)) catalog.blueprints.set(blueprint.name, { blueprint, sha, file, text, source: label });
      } catch (error) {
        catalog.errors.push({ file, message: (error as Error).message });
      }
    }
  }
  return catalog;
}
