import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_POD_CONTROL_KEY, suspendWorkspace, wakeWorkspace, WORKSPACE_CONTROL_KEY, workspaceControl } from "./workspace-control";

const g = globalThis as Record<symbol, unknown>;
afterEach(() => {
  delete g[WORKSPACE_CONTROL_KEY];
  delete g[LEGACY_POD_CONTROL_KEY];
});

/** A control that records its calls and refuses a suspend without force, like a pod with a running agent. */
function recorder(calls: unknown[]) {
  return {
    suspend: async (ws: string, o: { force?: boolean }) => {
      calls.push([ws, "suspend", o.force]);
      return o.force ? { ok: true } : { ok: false, busy: "claude is running" };
    },
    wake: async (ws: string) => {
      calls.push([ws, "wake"]);
      return { ok: true };
    },
  };
}

describe("workspace control", () => {
  it("says so when the runtime offers none", async () => {
    expect(await suspendWorkspace("kubernetes", "ws", false)).toMatchObject({ ok: false, message: expect.stringContaining("no workspace control") });
    await expect(wakeWorkspace("kubernetes", "ws")).resolves.toBeUndefined();
  });

  it("suspends and wakes through the control the runtime registered, and relays a busy refusal", async () => {
    const calls: unknown[] = [];
    g[WORKSPACE_CONTROL_KEY] = { kubernetes: recorder(calls) };
    expect(await suspendWorkspace("kubernetes", "ws", false)).toEqual({ ok: false, message: "busy: claude is running" });
    expect(await suspendWorkspace("kubernetes", "ws", true)).toEqual({ ok: true });
    await wakeWorkspace("kubernetes", "ws");
    expect(calls).toEqual([["ws", "suspend", false], ["ws", "suspend", true], ["ws", "wake"]]);
  });

  it("picks the control of the Factory's runtime, not another one", async () => {
    const calls: unknown[] = [];
    g[WORKSPACE_CONTROL_KEY] = { other: recorder(calls) };
    expect(workspaceControl("kubernetes")).toBeNull();
    expect(await suspendWorkspace("other", "ws", true)).toEqual({ ok: true });
    expect(calls).toEqual([["ws", "suspend", true]]);
  });

  it("a failed wake throws its message", async () => {
    g[WORKSPACE_CONTROL_KEY] = { kubernetes: { suspend: async () => ({ ok: true }), wake: async () => ({ ok: false, message: "no pod" }) } };
    await expect(wakeWorkspace("kubernetes", "ws")).rejects.toThrow("no pod");
  });

  describe("an older Kubernetes Runtime (legacy key only)", () => {
    const legacy = (calls: unknown[]) => ({
      podAction: async (ws: string, action: string, o: { force?: boolean }) => {
        calls.push([ws, action, o.force]);
        return action === "suspend" && !o.force ? { ok: false, busy: "claude is running" } : { ok: true };
      },
    });

    it("is still used for the kubernetes runtime: suspend and resume through its podAction", async () => {
      const calls: unknown[] = [];
      g[LEGACY_POD_CONTROL_KEY] = legacy(calls);
      expect(await suspendWorkspace("kubernetes", "ws", false)).toEqual({ ok: false, message: "busy: claude is running" });
      expect(await suspendWorkspace("kubernetes", "ws", true)).toEqual({ ok: true });
      await wakeWorkspace("kubernetes", "ws");
      expect(calls).toEqual([["ws", "suspend", false], ["ws", "suspend", true], ["ws", "resume", undefined]]);
    });

    it("is never used for another runtime", () => {
      g[LEGACY_POD_CONTROL_KEY] = legacy([]);
      expect(workspaceControl("local")).toBeNull();
    });

    it("loses to the registry when a Runtime offers both", async () => {
      const oldCalls: unknown[] = [];
      const newCalls: unknown[] = [];
      g[LEGACY_POD_CONTROL_KEY] = legacy(oldCalls);
      g[WORKSPACE_CONTROL_KEY] = { kubernetes: recorder(newCalls) };
      await suspendWorkspace("kubernetes", "ws", true);
      expect(newCalls).toHaveLength(1);
      expect(oldCalls).toHaveLength(0);
    });
  });
});
