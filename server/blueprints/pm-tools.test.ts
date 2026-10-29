import { describe, expect, it } from "vitest";
import { blueprintTools } from "./tools";
import type { CallContext } from "../tools";

function fake(pmOf: Record<string, string>) {
  const runs: Record<string, { id: string; pmAgentId: string | null; ownerAgentId: string | null; parent: { runId: string; stageId: string } | null; def: { pm_extra_max: number } }> = {
    "bp-a": { id: "bp-a", pmAgentId: "pm-a", ownerAgentId: null, parent: null, def: { pm_extra_max: 2 } },
    "bp-child": { id: "bp-child", pmAgentId: null, ownerAgentId: null, parent: { runId: "bp-a", stageId: "x" }, def: { pm_extra_max: 2 } },
    "bp-b": { id: "bp-b", pmAgentId: null, ownerAgentId: null, parent: null, def: { pm_extra_max: 2 } },
  };
  const calls: unknown[][] = [];
  const engine = {
    require: (id: string) => runs[id],
    hasLivePm: async () => false,
    pmRunOf: (id: string) => pmOf[id] ?? null,
    abort: async (id: string) => (calls.push(["abort", id]), { id, status: "aborted" }),
    resume: async (id: string, input: unknown) => (calls.push(["resume", id, input]), { id, status: "running", stage: "x" }),
    start: () => ({ id: "bp-new", stage: "x", status: "running" }),
  };
  const tools = blueprintTools({ engine: engine as never, catalog: async () => new Map() });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const ctx = (callerId: string) => ({ callerId, labels: async () => ({}) }) as unknown as CallContext;
  return { tool, ctx, calls };
}

describe("a run's PM acts only on its run", () => {
  it("steers its run and its child runs, not other runs", async () => {
    const { tool, ctx, calls } = fake({ "pm-a": "bp-a" });
    await tool("blueprint_abort").run({ run: "bp-child", reason: "x" }, ctx("pm-a"));
    await tool("blueprint_abort").run({ run: "bp-a", reason: "x" }, ctx("pm-a"));
    await expect(tool("blueprint_abort").run({ run: "bp-b", reason: "x" }, ctx("pm-a"))).rejects.toThrow(/only on it and its child runs/);
    expect(calls.map((c) => c[1])).toEqual(["bp-child", "bp-a"]);
  });

  it("starts no run and grants no more than pm_extra_max", async () => {
    const { tool, ctx } = fake({ "pm-a": "bp-a" });
    await expect(tool("blueprint_start").run({ blueprint: "flow", vars: {} }, ctx("pm-a"))).rejects.toThrow(/does not start runs/);
    await expect(tool("blueprint_resume").run({ run: "bp-a", stage: "x", extra_attempts: 3 }, ctx("pm-a"))).rejects.toThrow(/at most 2/);
    await tool("blueprint_resume").run({ run: "bp-a", stage: "x", extra_attempts: 2 }, ctx("pm-a"));
    // anyone else keeps the old caps
    await tool("blueprint_resume").run({ run: "bp-b", stage: "x", extra_attempts: 5 }, ctx("someone"));
  });
});
