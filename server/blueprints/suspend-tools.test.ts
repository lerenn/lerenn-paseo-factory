import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTrustedLabels } from "../trust";
import { blueprintTools, TOOL_NAMES } from "./tools";
import type { CallContext } from "../tools";

function fake() {
  const calls: unknown[][] = [];
  const run = { id: "bp-1", pmAgentId: null, ownerAgentId: null, status: "running", suspended: { pods: ["p"] } };
  const engine = {
    require: () => run,
    hasLivePm: async () => false,
    suspend: async (...a: unknown[]) => (calls.push(["suspend", ...a]), { id: "bp-1", status: "suspended", suspended: { pods: ["p"] } }),
    suspendAll: async (...a: unknown[]) => (calls.push(["suspendAll", ...a]), [{ id: "bp-1", status: "suspended", suspended: { pods: ["p"] } }]),
    resumeAllSuspended: (...a: unknown[]) => (calls.push(["resumeAll", ...a]), { runs: ["bp-1"], done: Promise.resolve() }),
    resume: async (...a: unknown[]) => (calls.push(["resume", ...a]), { id: "bp-1", status: "running", stage: "x" }),
  };
  const tools = blueprintTools({ engine: engine as never, catalog: async () => new Map() });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const ctx = (callerId: string, labels: Record<string, string> = {}) => ({ callerId, labels: async () => labels }) as unknown as CallContext;
  return { calls, tool, ctx };
}

describe("blueprint_suspend / blueprint_resume tools", () => {
  beforeEach(() => setTrustedLabels(["paseo.assistant=1"]));
  afterEach(() => setTrustedLabels([]));

  it("are listed for PMs", () => {
    expect(TOOL_NAMES).toContain("blueprint_suspend");
  });

  it("suspend takes a run or all, not both or neither", async () => {
    const { tool, ctx } = fake();
    await expect(tool("blueprint_suspend").run({ reason: "x" }, ctx("a"))).rejects.toThrow(/either run or all/);
    await expect(tool("blueprint_suspend").run({ run: "bp-1", all: true, reason: "x" }, ctx("a"))).rejects.toThrow(/either run or all/);
  });

  it("all=true is for a trusted agent and the Supervisor", async () => {
    const { tool, ctx, calls } = fake();
    await expect(tool("blueprint_suspend").run({ all: true, reason: "freeze" }, ctx("pm"))).rejects.toThrow(/trusted label/);
    const out = await tool("blueprint_suspend").run({ all: true, reason: "freeze", force: true }, ctx("assistant", { "paseo.assistant": "1" }));
    expect(out).toMatchObject({ factory_suspended: true, suspended: [{ run_id: "bp-1", status: "suspended", pods: ["p"] }] });
    expect(calls[0]).toEqual(["suspendAll", { reason: "freeze", by: "assistant", force: true }]);
    await expect(tool("blueprint_resume").run({ all: true }, ctx("pm"))).rejects.toThrow(/trusted label/);
    await tool("blueprint_resume").run({ all: true, concurrency: 3 }, ctx("assistant", { "paseo.assistant": "1" }));
    expect(calls[1]).toEqual(["resumeAll", { concurrency: 3, note: undefined }]);
  });

  it("a single run is suspended and resumed by name", async () => {
    const { tool, ctx, calls } = fake();
    expect(await tool("blueprint_suspend").run({ run: "bp-1", reason: "freeze" }, ctx("anyone"))).toMatchObject({ run_id: "bp-1", status: "suspended" });
    await tool("blueprint_resume").run({ run: "bp-1", note: "go" }, ctx("anyone"));
    expect(calls).toEqual([["suspend", "bp-1", { reason: "freeze", by: "anyone", force: undefined }], ["resume", "bp-1", { stage: undefined, extraAttempts: undefined, note: "go" }]]);
  });

  it("attach_agent is for a trusted agent and the Supervisor", async () => {
    const { tool, ctx, calls } = fake();
    await expect(tool("blueprint_resume").run({ run: "bp-1", stage: "x", attach_agent: "a-1" }, ctx("pm"))).rejects.toThrow(/attach_agent is for an agent with a trusted label/);
    await tool("blueprint_resume").run({ run: "bp-1", stage: "x", attach_agent: "a-1" }, ctx("assistant", { "paseo.assistant": "1" }));
    expect(calls.at(-1)).toEqual(["resume", "bp-1", { stage: "x", extraAttempts: undefined, note: undefined, attachAgent: "a-1" }]);
  });

  it("trusts nobody by label when trustedLabels is empty", async () => {
    setTrustedLabels([]);
    const { tool, ctx } = fake();
    await expect(tool("blueprint_suspend").run({ all: true, reason: "freeze" }, ctx("assistant", { "paseo.assistant": "1" }))).rejects.toThrow(/trusted label/);
    await expect(tool("blueprint_suspend").run({ all: true, reason: "freeze" }, ctx("sup", { "paseo.factory.supervisor": "1" }))).resolves.toMatchObject({ factory_suspended: true });
  });
});
