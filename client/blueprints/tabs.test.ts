import { describe, expect, it } from "vitest";
import { BLUEPRINTS_SUBTABS } from "./tabs";

describe("Blueprints sub-tabs", () => {
  it("are Runs | Templates | Crons | Settings", () => {
    expect(BLUEPRINTS_SUBTABS.map((t) => t.label)).toEqual(["Runs", "Templates", "Crons", "Settings"]);
  });
});
