import { describe, expect, it, vi } from "vitest";
import { archiveWorkspaceWithAgent, type ArchiveWorkspacePorts } from "./archive-workspace";

function make(over: Partial<ArchiveWorkspacePorts> = {}) {
  const ports: ArchiveWorkspacePorts = {
    workspaceOf: () => "ws1",
    liveAgentsIn: async () => [],
    trace: async () => "clean",
    archiveWorkspace: vi.fn(async () => undefined),
    log: vi.fn(),
    ...over,
  };
  return ports;
}

describe("archiveWorkspaceWithAgent", () => {
  it("archives the workspace of a Factory agent once it is alone and clean, and logs one line", async () => {
    const ports = make();
    expect(await archiveWorkspaceWithAgent(ports, "a1")).toBe("archived");
    expect(ports.archiveWorkspace).toHaveBeenCalledWith("ws1");
    expect(ports.log).toHaveBeenCalledTimes(1);
  });

  it("leaves agents without a Factory workspace alone (not ours, or local)", async () => {
    const ports = make({ workspaceOf: () => null });
    expect(await archiveWorkspaceWithAgent(ports, "a1")).toBe("skipped");
    expect(ports.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("keeps a shared workspace while another agent lives in it", async () => {
    const ports = make({ liveAgentsIn: async () => ["a1", "a2"] });
    expect(await archiveWorkspaceWithAgent(ports, "a1")).toBe("kept");
    expect(ports.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("archives the last agent's shared workspace", async () => {
    const ports = make({ liveAgentsIn: async () => ["a1"] });
    expect(await archiveWorkspaceWithAgent(ports, "a1")).toBe("archived");
  });

  it("keeps the workspace when agents cannot be listed", async () => {
    const ports = make({ liveAgentsIn: async () => null });
    expect(await archiveWorkspaceWithAgent(ports, "a1")).toBe("kept");
    expect(ports.archiveWorkspace).not.toHaveBeenCalled();
  });

  it("archives a dirty workspace too, and says what was in it", async () => {
    const ports = make({ trace: async () => "2 entries: M a.ts; ?? b.ts" });
    expect(await archiveWorkspaceWithAgent(ports, "a1")).toBe("archived");
    expect(ports.archiveWorkspace).toHaveBeenCalledWith("ws1");
    expect(ports.log).toHaveBeenCalledWith(expect.stringContaining("M a.ts"));
  });

  it("archives even when the trace fails", async () => {
    const ports = make({ trace: async () => { throw new Error("pod suspended"); } });
    expect(await archiveWorkspaceWithAgent(ports, "a1")).toBe("archived");
  });

  it("does not throw when archiving fails", async () => {
    const ports = make({ archiveWorkspace: async () => { throw new Error("boom"); } });
    expect(await archiveWorkspaceWithAgent(ports, "a1")).toBe("kept");
  });
});
