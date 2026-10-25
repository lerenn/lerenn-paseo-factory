import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { roleNameSchema } from "../shared/role";
import type { RoleEntry } from "../shared/rpc";
import { describeError, EXTENSIONS, parseRole } from "./loader";

export interface GitLayer {
  /** Stable id of the git source, as in GitStatus.id. */
  id: string;
  /** Display label, e.g. "owner/repo@main". */
  label: string;
  /** The source's roles folder inside its local clone. */
  dir: string;
}

async function readDir(layer: GitLayer): Promise<Omit<RoleEntry, "overrides">[]> {
  let files: string[];
  try {
    files = await readdir(layer.dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: Omit<RoleEntry, "overrides">[] = [];
  for (const base of files.sort()) {
    const ext = path.extname(base);
    if (!EXTENSIONS.includes(ext)) continue;
    const name = path.basename(base, ext);
    if (!roleNameSchema.safeParse(name).success) continue;
    // loadRole tries .yaml, .yml, .json in that order; a later duplicate is unreachable.
    if (entries.some((entry) => entry.name === name)) continue;
    const file = path.join(layer.dir, base);
    const text = await readFile(file, "utf8");
    const common = { name, origin: layer.label, sourceId: layer.id, file, text };
    try {
      entries.push({ ...common, role: parseRole(text, file) });
    } catch (error) {
      entries.push({ ...common, error: describeError(error) });
    }
  }
  return entries;
}

/** All roles from the git sources, one entry per name; an earlier source wins. */
export async function listRoles(layers: GitLayer[]): Promise<RoleEntry[]> {
  const byName = new Map<string, RoleEntry>();
  for (const layer of layers) {
    for (const entry of await readDir(layer)) {
      const winner = byName.get(entry.name);
      if (winner) winner.overrides.push(entry.origin);
      else byName.set(entry.name, { ...entry, overrides: [] });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
