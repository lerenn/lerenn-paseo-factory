import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store, SUPERVISE_TASK } from "./store";

describe("store migration", () => {
  it("turns old supervisions into normal watch tasks", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "warden-")), "state.json");
    writeFileSync(file, JSON.stringify({ sessions: {}, agents: {}, tasks: [], supervisions: [{ agentId: "boss", createdAt: 5, pings: 2, unanswered: 1 }] }));
    const store = new Store(file);
    expect(store.active("boss")).toMatchObject([{ task: SUPERVISE_TASK, registeredBy: "user", source: "user", createdAt: 5, pings: 2, unanswered: 1 }]);
    store.save();
    expect(new Store(file).active("boss")).toHaveLength(1);
  });
});
