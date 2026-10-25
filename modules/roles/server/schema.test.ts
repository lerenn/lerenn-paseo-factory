import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { roleSchema } from "../shared/role";

const file = new URL("../../../role.schema.json", import.meta.url);
const generated = JSON.stringify(z.toJSONSchema(roleSchema, { io: "input" }), null, 2) + "\n";

describe("role.schema.json", () => {
  it("matches the zod schema (run `npm run schema` to regenerate)", () => {
    if (process.env.UPDATE_SCHEMA) writeFileSync(file, generated);
    expect(readFileSync(file, "utf8")).toBe(generated);
  });
});
