import { parse } from "smol-toml";
import { createHash } from "node:crypto";
import { blueprintSchema, type Blueprint } from "../../shared/blueprints/blueprint";

export interface Loaded {
  blueprint: Blueprint;
  sha: string;
}

/** Parse and validate one blueprint file. Errors name the offending path. */
export function parseBlueprint(text: string): Loaded {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new Error(`not valid TOML: ${(error as Error).message}`);
  }
  const result = blueprintSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `${i.path.join(".") || "blueprint"}: ${i.message}`).join("; "));
  }
  return { blueprint: result.data, sha: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}
