import { describe, expect, it } from "vitest";
import { supervisorStateLabel } from "./state-label";

describe("supervisorStateLabel", () => {
  it("labels each state", () => {
    expect(supervisorStateLabel(undefined, false)).toBe("…");
    expect(supervisorStateLabel("disabled", true)).toBe("Disabled (the Assistant watches the Factory)");
    expect(supervisorStateLabel("waking", false)).toBe("Waking…");
    expect(supervisorStateLabel("archived", true)).toBe("Archived (idle)");
    expect(supervisorStateLabel("not-started", true)).toBe("Archived (idle)");
    expect(supervisorStateLabel("not-started", false)).toBe("Not started");
    expect(supervisorStateLabel("running", true)).toBe("Running");
    expect(supervisorStateLabel("idle", true)).toBe("Running");
  });
});
