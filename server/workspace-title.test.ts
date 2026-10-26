import { describe, expect, it, vi } from "vitest";
import { retitleFactoryWorkspaces, roleDisplayName, workspaceTitle } from "./workspace-title";

describe("workspace titles", () => {
  it("capitalises role names", () => {
    expect(roleDisplayName("supervisor")).toBe("Supervisor");
    expect(roleDisplayName("pr-babysitter")).toBe("PR Babysitter");
    expect(roleDisplayName("qa")).toBe("QA");
  });

  it("is the role alone when there is no subject", () => {
    expect(workspaceTitle("supervisor")).toBe("Supervisor");
  });

  it("puts the ticket key first, then its title", () => {
    expect(workspaceTitle("investigator", { ticket: "ANY-1234", ticket_title: "Ticket Subject" })).toBe("Investigator: ANY-1234 Ticket Subject");
    expect(workspaceTitle("implementer", { ticket: "ANY-1", ticket_text: "\nFirst line title\nbody" })).toBe("Implementer: ANY-1 First line title");
    expect(workspaceTitle("qa", { ticket: "ANY-1" })).toBe("QA: ANY-1");
  });

  it("keeps the key when the title is long", () => {
    const t = workspaceTitle("pm", { ticket: "ANY-9", ticket_title: "x".repeat(300) }, "ticket bp-1");
    expect(t.startsWith("PM: ANY-9 xxx")).toBe(true);
    expect(t.length).toBeLessThan(100);
  });

  it("uses the incident, then the alert summary, then the run name", () => {
    expect(workspaceTitle("investigator", { incident_id: "INC-7", alert_text: "boom" })).toBe("Investigator: INC-7");
    expect(workspaceTitle("investigator", { alert_text: "Disk full on db-1\nmore" })).toBe("Investigator: Disk full on db-1");
    expect(workspaceTitle("releaser", {}, "release bp-3")).toBe("Releaser: release bp-3");
  });

  it("re-titles live Factory agents only, from their labels and run", async () => {
    const setTitle = vi.fn(async () => ({ title: null }));
    const refresh = vi.fn(async () => ({ title: "Handle Factory Supervisor digests" }));
    const paseo = {
      agents: {
        list: async () => ({
          entries: [
            { agent: { id: "s", labels: { "paseo.factory": "1", "paseo.factory.supervisor": "1", "paseo.factory.role": "supervisor" } } },
            { agent: { id: "w", labels: { "paseo.factory": "1", "paseo.factory.role": "investigator", "paseo.factory.run": "bp-1" } } },
            { agent: { id: "x", labels: {} } },
          ],
        }),
        ref: (id: string) => ({ refresh: async () => ({ agent: { workspaceId: `ws-${id}` } }) }),
      },
      workspaces: { ref: () => ({ refresh, setTitle }) },
    };
    await retitleFactoryWorkspaces(paseo as never, (id) => (id === "bp-1" ? { vars: { ticket: "ANY-5", ticket_title: "Fix it" }, blueprint: "ticket" } : undefined));
    expect(setTitle.mock.calls).toEqual([["Supervisor"], ["Investigator: ANY-5 Fix it"]]);
  });
});
