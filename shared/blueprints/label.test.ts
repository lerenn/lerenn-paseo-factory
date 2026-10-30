import { describe, expect, it } from "vitest";
import { approvalKey, approvalScope, customLabel, renderRunTemplate, runLabel } from "./label";

const run = (vars: Record<string, string>, def?: { label?: string; approval_scope?: string }) => ({ id: "run-1", blueprint: "flow", vars, def });

describe("run label and approval scope", () => {
  it("default label and approval key equal the format before they existed", () => {
    const ticket = run({ ticket: "ABC-1", incident_id: "INC-9" });
    expect(runLabel(ticket)).toBe("ABC-1");
    expect(approvalKey(ticket, "criteria", "sha")).toBe("ABC-1:criteria:sha");

    const incident = run({ incident_id: "INC-9" });
    expect(runLabel(incident)).toBe("INC-9");
    // the old key never used incident_id: ticket || blueprint
    expect(approvalKey(incident, "criteria", "sha")).toBe("flow:criteria:sha");

    const neither = run({ other: "x" });
    expect(runLabel(neither)).toBe("run-1");
    expect(runLabel(neither, "flow")).toBe("flow");
    expect(runLabel(neither, "")).toBe("");
    expect(approvalKey(neither, "criteria", "sha")).toBe("flow:criteria:sha");
    expect(customLabel(neither)).toBeUndefined();
  });

  it("renders a custom label and approval scope from the run's vars", () => {
    const r = run({ repo: "org/app", ticket: "ABC-1", severity: "critical" }, { label: "{{repo}} {{vars.severity}}", approval_scope: "{{blueprint}}/{{repo}}" });
    expect(runLabel(r)).toBe("org/app critical");
    expect(customLabel(r)).toBe("org/app critical");
    expect(approvalScope(r)).toBe("flow/org/app");
    expect(approvalKey(r, "criteria", "sha")).toBe("flow/org/app:criteria:sha");
    expect(renderRunTemplate("{{run.id}} · {{missing}}", r)).toBe("run-1 ·");
  });

  it("falls back when a custom template renders empty", () => {
    const r = run({ ticket: "ABC-1" }, { label: "{{repo}}", approval_scope: "{{repo}}" });
    expect(runLabel(r)).toBe("ABC-1");
    expect(customLabel(r)).toBeUndefined();
    expect(approvalScope(r)).toBe("flow");
  });
});
