import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTrustedLabels } from "../trust";
import { settingsSchema } from "../../shared/inbox/settings";
import { Engine, UsageError } from "./engine";
import { Store } from "./store";
import { TOOLS } from "./tools";

const withdraw = TOOLS.find((t) => t.name === "inbox_withdraw")!;

function setup() {
  const engine = new Engine(new Store(null), { send: async () => {}, isArchived: async () => false }, () => settingsSchema.parse({ globalGapSeconds: 0 }), () => 1_000_000);
  const factoryItem = engine.ask({ agentId: "blueprint:bp-1", question: "Run bp-1 is paused", internal: true } as never).item;
  const workerItem = engine.ask({ agentId: "worker", question: "Merge?" }).item;
  const ctx = (callerId: string, labels: Record<string, string> = {}) => ({ engine, callerId, labels: async () => labels });
  return { engine, factoryItem, workerItem, ctx };
}

describe("inbox_withdraw", () => {
  beforeEach(() => setTrustedLabels(["paseo.assistant=1"]));
  afterEach(() => setTrustedLabels([]));

  it("treats no one as trusted when trustedLabels is empty", async () => {
    setTrustedLabels([]);
    const { factoryItem, ctx } = setup();
    await expect(Promise.resolve().then(() => withdraw.run({ item_id: factoryItem.id }, ctx("assistant", { "paseo.assistant": "1" })))).rejects.toThrow(UsageError);
  });

  it("lets the Assistant withdraw a Factory-internal item", async () => {
    const { engine, factoryItem, ctx } = setup();
    await withdraw.run({ item_id: factoryItem.id, reason: "run is running again" }, ctx("assistant", { "paseo.assistant": "1" }));
    expect(engine.store.get(factoryItem.id)?.status).toBe("withdrawn");
  });

  it("refuses everyone else, and the Assistant for items of other agents", async () => {
    const { engine, factoryItem, workerItem, ctx } = setup();
    await expect(Promise.resolve().then(() => withdraw.run({ item_id: factoryItem.id }, ctx("plain")))).rejects.toThrow(UsageError);
    await expect(Promise.resolve().then(() => withdraw.run({ item_id: workerItem.id }, ctx("assistant", { "paseo.assistant": "1" })))).rejects.toThrow(UsageError);
    expect(engine.store.get(factoryItem.id)?.status).toBe("pending");
    expect(engine.store.get(workerItem.id)?.status).toBe("pending");
  });

  it("still lets an agent withdraw its own item", async () => {
    const { engine, workerItem, ctx } = setup();
    await withdraw.run({ item_id: workerItem.id }, ctx("worker"));
    expect(engine.store.get(workerItem.id)?.status).toBe("withdrawn");
  });
});

describe("inbox_answer scoped to a run's PM", () => {
  const answerTool = TOOLS.find((t) => t.name === "inbox_answer")!;
  beforeEach(() => setTrustedLabels(["paseo.assistant=1"]));
  afterEach(() => setTrustedLabels([]));

  it("lets the PM answer only the item the Blueprints engine allows, recorded as answered by the PM", async () => {
    const { engine, factoryItem, workerItem, ctx } = setup();
    engine.mayAnswer = (agentId, itemId) => agentId === "pm-1" && itemId === factoryItem.id;
    await expect(Promise.resolve().then(() => answerTool.run({ item: workerItem.id, answer: "yes" }, ctx("pm-1")))).rejects.toThrow(/pm = true gate/);
    await expect(Promise.resolve().then(() => answerTool.run({ item: factoryItem.id, answer: "yes" }, ctx("pm-2")))).rejects.toThrow(UsageError);
    const out = (await answerTool.run({ item: factoryItem.id, answer: "go on" }, ctx("pm-1"))) as { recorded_as: string };
    expect(out.recorded_as).toBe("answered by the run's PM");
    expect(engine.store.get(factoryItem.id)?.answer?.by).toBe("pm");
  });
});
