import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RoleLimits, type AgentActivity } from "./limits";

const file = async () => path.join(await mkdtemp(path.join(tmpdir(), "limits-")), "agents.json");
const states = (m: Record<string, AgentActivity>) => async (id: string) => m[id] ?? "gone";

describe("RoleLimits", () => {
  it("allows creation under the cap and refuses over it with a clear message", async () => {
    const limits = new RoleLimits(await file());
    limits.register("a1", "qa", true);
    await limits.reserve("qa", 2, states({ a1: "active" }));
    await expect(limits.reserve("qa", 2, states({ a1: "active" }))).rejects.toThrow(
      /Role "qa" is at its limit of 2 concurrent agents \(2 running or starting\)/,
    );
  });

  it("counts only working agents of that role", async () => {
    const limits = new RoleLimits(await file());
    limits.register("a1", "qa", true);
    limits.register("a2", "qa", true);
    limits.register("b1", "other", true);
    // one idle, one working, plus another role's agent
    await limits.reserve("qa", 2, states({ a1: "inactive", a2: "active", b1: "active" }));
    await expect(limits.reserve("qa", 2, states({ a1: "inactive", a2: "active" }))).rejects.toThrow(/limit of 2/);
  });

  it("counts a reservation until the session opens, then the registered agent instead", async () => {
    const limits = new RoleLimits(await file());
    await limits.reserve("qa", 1, states({}));
    await expect(limits.reserve("qa", 1, states({}))).rejects.toThrow(/limit of 1 concurrent agent /);
    limits.register("a1", "qa", true);
    await expect(limits.reserve("qa", 1, states({ a1: "active" }))).rejects.toThrow(/limit of 1/);
    await limits.reserve("qa", 1, states({ a1: "inactive" }));
  });

  it("expires a reservation whose agent never opened a session", async () => {
    let now = 1_000;
    const limits = new RoleLimits(await file(), () => now);
    await limits.reserve("qa", 1, states({}));
    now += 3 * 60_000;
    await limits.reserve("qa", 1, states({}));
  });

  it("forgets agents that are gone and remembers the rest across instances", async () => {
    const f = await file();
    const first = new RoleLimits(f);
    first.register("a1", "qa", true);
    first.register("a2", "qa", false);
    const second = new RoleLimits(f);
    await second.reserve("qa", 2, states({ a1: "active", a2: "gone" }));
    const third = new RoleLimits(f);
    await third.reserve("qa", 2, states({ a1: "active" }));
  });
});
