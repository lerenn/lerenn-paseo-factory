import { describe, expect, it } from "vitest";
import { builtinTabs } from "./tabs";

const TITLES = { blueprints: "Blueprints", roles: "Roles", leases: "Leases", warden: "Warden", inbox: "Inbox", supervisor: "Supervisor" };
const KEYS = { overview: "~overview", activity: "~activity", settings: "~settings" };

describe("Factory top tabs", () => {
  it("has no Crons tab: crons are a Blueprints sub-tab", () => {
    expect(builtinTabs(undefined, TITLES, KEYS).map((t) => t.label)).toEqual(["Overview", "Supervisor", "Activity", "Roles", "Blueprints", "Leases", "Warden", "Inbox", "Settings"]);
  });

  it("leaves out modules that are off", () => {
    expect(builtinTabs({ blueprints: false, supervisor: false }, TITLES, KEYS).map((t) => t.key)).toEqual(["~overview", "~activity", "roles", "leases", "warden", "inbox", "~settings"]);
  });
});
