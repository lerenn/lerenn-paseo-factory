import { describe, expect, it, vi } from "vitest";
import { listAgents } from "./list-agents";

describe("listAgents", () => {
  it("asks for agents of background workspaces too, but not archived ones", async () => {
    const list = vi.fn(async (_o: unknown) => ({ entries: [] }));
    await listAgents({ agents: { list } } as never);
    expect(list).toHaveBeenCalledWith({ filter: { includeArchived: false, includeBackground: true } });
  });
});
