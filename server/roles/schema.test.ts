import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { roleSchema } from "../../shared/roles/role";

const file = new URL("../../role.schema.json", import.meta.url);
const generated = JSON.stringify(z.toJSONSchema(roleSchema, { io: "input" }), null, 2) + "\n";

describe("role.schema.json", () => {
  it("matches the zod schema (run `npm run schema` to regenerate)", () => {
    if (process.env.UPDATE_SCHEMA) writeFileSync(file, generated);
    expect(readFileSync(file, "utf8")).toBe(generated);
  });
});

describe("runtimeProfile", () => {
  const parse = (extra: object) => roleSchema.safeParse({ name: "r", ...extra });
  it("is optional", () => {
    const r = parse({});
    expect(r.success && r.data.runtimeProfile).toBeUndefined();
  });
  it("accepts a profile name", () => {
    const r = parse({ runtimeProfile: "builder-large" });
    expect(r.success && r.data.runtimeProfile).toBe("builder-large");
  });
  it.each(["Small", "1gi", "-x", "a_b", "", "a".repeat(33)])("rejects %j", (v) => {
    expect(parse({ runtimeProfile: v }).success).toBe(false);
  });
});
