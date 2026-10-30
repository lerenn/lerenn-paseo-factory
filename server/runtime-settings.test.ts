import { describe, expect, it } from "vitest";
import { factorySettingsSchema, LOCAL_RUNTIME } from "../shared/settings";
import { settingsSchema } from "../shared/blueprints/settings";

describe("runtime settings", () => {
  it("the Factory runtime is a free string, local by default", () => {
    expect(factorySettingsSchema.parse({}).runtime).toBe(LOCAL_RUNTIME);
    expect(factorySettingsSchema.parse({ runtime: "kubernetes" }).runtime).toBe("kubernetes");
    expect(factorySettingsSchema.parse({ runtime: "nomad" }).runtime).toBe("nomad");
    expect(factorySettingsSchema.safeParse({ runtime: " " }).success).toBe(false);
  });

  it("retro.runtime is empty by default (the Factory's runtime) and keeps the other retro defaults", () => {
    expect(settingsSchema.parse({}).retro.runtime).toBe("");
    expect(settingsSchema.parse({ retro: { mailTo: "@user" } }).retro).toMatchObject({ runtime: "", role: "retro", enabled: true });
    expect(settingsSchema.parse({ retro: { runtime: "kubernetes" } }).retro.runtime).toBe("kubernetes");
  });
});
