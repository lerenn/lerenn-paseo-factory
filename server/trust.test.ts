import { afterEach, describe, expect, it } from "vitest";
import { factorySettingsSchema } from "../shared/settings";
import { getTrustedLabels, isTrusted, parseTrustedLabels, setTrustedLabels } from "./trust";

afterEach(() => setTrustedLabels([]));

describe("trusted labels", () => {
  it("trust nobody and exclude nothing by default", () => {
    const s = factorySettingsSchema.parse({});
    expect(s.trustedLabels).toEqual([]);
    expect(s.excludePaths).toEqual([]);
    setTrustedLabels(s.trustedLabels);
    expect(isTrusted({ "paseo.assistant": "1" })).toBe(false);
  });

  it("match an agent carrying any configured key=value", () => {
    setTrustedLabels(["paseo.assistant=1", " team = ops "]);
    expect(getTrustedLabels()).toEqual(["paseo.assistant=1", "team=ops"]);
    expect(isTrusted({ "paseo.assistant": "1" })).toBe(true);
    expect(isTrusted({ team: "ops" })).toBe(true);
    expect(isTrusted({ "paseo.assistant": "0" })).toBe(false);
    expect(isTrusted(undefined)).toBe(false);
  });

  it("ignore entries without a key", () => {
    expect(parseTrustedLabels(["=1", "novalue", "a="])).toEqual([{ key: "a", value: "" }]);
  });
});
