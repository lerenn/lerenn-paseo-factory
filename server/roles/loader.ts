import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { roleNameSchema, roleSchema, type Role } from "../../shared/roles/role";

export const EXTENSIONS = [".yaml", ".yml", ".json"];

/** One-line message for a parse or validation failure. */
export function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "role"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

/** Parse role text without checking it against a file name. YAML also reads JSON. */
export function parseRoleText(source: string): Role {
  return roleSchema.parse(parse(source));
}

export function parseRole(source: string, file: string): Role {
  const role = parseRoleText(source);
  const expected = path.basename(file, path.extname(file));
  if (role.name !== expected) {
    throw new Error(`${file}: role name "${role.name}" must match the file name "${expected}"`);
  }
  return role;
}

/** Find a role by name; earlier directories win. Null when none has it. */
export async function loadRole(name: string, dirs: string[]): Promise<Role | null> {
  const safe = roleNameSchema.parse(name);
  for (const dir of dirs) {
    for (const ext of EXTENSIONS) {
      const file = path.join(dir, safe + ext);
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        return parseRole(source, file);
      } catch (error) {
        throw new Error(`Invalid role file ${file}: ${describeError(error)}`);
      }
    }
  }
  return null;
}
