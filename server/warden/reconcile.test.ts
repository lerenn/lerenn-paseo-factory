import { describe, expect, it } from "vitest";
import { watchesToDrop } from "./reconcile";

const tasks = [{ agentId: "ok" }, { agentId: "plain" }, { agentId: "gone" }, { agentId: "closed" }];
const live: { id: string; status?: string; labels?: Record<string, string> }[] = [
  { id: "ok", status: "running", labels: { "paseo.factory": "1" } },
  { id: "plain", status: "idle", labels: {} },
  { id: "closed", status: "closed", labels: { "paseo.factory": "1" } },
];

describe("watchesToDrop", () => {
  it("drops watches of archived, closed and non-Factory agents, keeps Factory ones", () => {
    expect(watchesToDrop(tasks, live).map((d) => [d.task.agentId, d.why])).toEqual([["plain", "not-factory"], ["gone", "archived"], ["closed", "archived"]]);
  });
  it("drops nothing when the live list is empty", () => {
    expect(watchesToDrop(tasks, [])).toEqual([]);
  });
});
