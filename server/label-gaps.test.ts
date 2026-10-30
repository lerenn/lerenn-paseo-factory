import { describe, expect, it } from "vitest";
import { settingsSchema as blueprintsSettingsSchema } from "../shared/blueprints/settings";
import { settingsSchema as supervisorSettingsSchema } from "../shared/supervisor/settings";
import { spendRole } from "./blueprints/spend-recompute";
import { probeAgent } from "./blueprints/usage-limit";
import { extensionLabels } from "./services";

// Decision 93c2a1b0: every Factory agent carries paseo.factory=1 and a non-empty role.
describe("usage-limit probe", () => {
  it("is a Factory agent whose spend counts as Usage probe", () => {
    const o = probeAgent("claude/claude-haiku-5-5", "/tmp", 1);
    expect(o.labels).toEqual({ "paseo.factory": "1", "paseo.factory.usage-probe": "1" });
    expect(o.env).toMatchObject({ PASEO_WARDEN: "off", PASEO_USAGE_LIMIT: "off" });
    expect(spendRole(o.labels, o.title)).toBe("Usage probe");
  });
});

describe("extension spawn labels", () => {
  it("keep the extension's own labels and the Factory's win", () => {
    expect(extensionLabels("qa", { team: "x", "paseo.factory": "0", "paseo.factory.role": "admin", "paseo.factory.supervisor": "1", "paseo.factory.run": "bp-1" })).toEqual({
      team: "x",
      "paseo.factory": "1",
      "paseo.factory.role": "qa",
    });
    expect(extensionLabels(undefined, { "paseo.factory": "" })).toEqual({ "paseo.factory": "1" });
    expect(extensionLabels(undefined)).toEqual({ "paseo.factory": "1" });
  });
});

describe("role settings", () => {
  it("treat an empty or blank role as unset", () => {
    for (const blank of ["", "   "]) {
      const b = blueprintsSettingsSchema.parse({ pmRole: blank, retro: { role: blank } });
      expect(b.pmRole).toBe("pm");
      expect(b.retro.role).toBe("retro");
      expect(supervisorSettingsSchema.parse({ role: blank }).role).toBe("supervisor");
    }
    expect(blueprintsSettingsSchema.parse({}).pmRole).toBe("pm");
    expect(blueprintsSettingsSchema.parse({}).retro.role).toBe("retro");
    expect(supervisorSettingsSchema.parse({}).role).toBe("supervisor");
    expect(blueprintsSettingsSchema.parse({ pmRole: " lead-pm ", retro: { role: "retro-2" } })).toMatchObject({ pmRole: "lead-pm", retro: { role: "retro-2" } });
    expect(supervisorSettingsSchema.parse({ role: "ops" }).role).toBe("ops");
  });
});
