import { describe, expect, it } from "vitest";
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
