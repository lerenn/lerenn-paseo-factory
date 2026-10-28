import { afterEach, describe, expect, it } from "vitest";
import { POD_CONTROL_KEY, suspendPod, wakePod } from "./pod-control";

const g = globalThis as Record<symbol, unknown>;
afterEach(() => delete g[POD_CONTROL_KEY]);

describe("pod control", () => {
  it("says so when the Runtime offers none", async () => {
    expect(await suspendPod("ws", false)).toMatchObject({ ok: false, message: expect.stringContaining("no pod control") });
    await expect(wakePod("ws")).resolves.toBeUndefined();
  });

  it("suspends and wakes through the Runtime's pod action, and relays a busy refusal", async () => {
    const calls: unknown[] = [];
    g[POD_CONTROL_KEY] = {
      podAction: async (ws: string, action: string, o: { force?: boolean }) => {
        calls.push([ws, action, o.force]);
        return action === "suspend" && !o.force ? { ok: false, busy: "claude is running" } : { ok: true };
      },
    };
    expect(await suspendPod("ws", false)).toEqual({ ok: false, message: "busy: claude is running" });
    expect(await suspendPod("ws", true)).toEqual({ ok: true });
    await wakePod("ws");
    expect(calls).toEqual([["ws", "suspend", false], ["ws", "suspend", true], ["ws", "resume", undefined]]);
  });
});
