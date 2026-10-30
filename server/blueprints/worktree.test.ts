import { afterEach, describe, expect, it, vi } from "vitest";
import type { Paseo } from "../host";
import { ActivityClock, freshTrace, statusTrace, TRACE_FRESH_MS, worktreeCheck } from "./worktree";

/** A Paseo whose terminal prints `lines` between the markers, after `createMs`. */
function fakePaseo(lines: string[] | null, createMs = 0) {
  const killed: string[] = [];
  const paseo = {
    terminals: {
      create: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                capture: async () => ({ lines: lines ? ["FACTORY_TRACE_BEGIN", ...lines, "FACTORY_TRACE_END"] : [] }),
                kill: async () => void killed.push("t"),
              }),
            createMs,
          ),
        ),
    },
  } as unknown as Paseo;
  return { paseo, killed };
}

describe("statusTrace", () => {
  it("reads git status and kills its terminal", async () => {
    const { paseo, killed } = fakePaseo([" M a.ts"]);
    expect(await statusTrace(paseo, "ws", 2_000)).toBe("1 entries:  M a.ts");
    expect(killed).toHaveLength(1);
  });

  it("a terminal that only comes up after the timeout (a pod resuming) is killed too", async () => {
    const { paseo, killed } = fakePaseo([], 150);
    expect(await statusTrace(paseo, "ws", 50)).toBe("no answer (0 s)");
    await new Promise((r) => setTimeout(r, 200));
    expect(killed).toHaveLength(1);
  });
});

describe("freshTrace (decision 12885996: a trace must not wake a suspended pod)", () => {
  const trace = async () => "clean";
  it("traces a workspace active lately", async () => {
    expect(await freshTrace(trace, "ws", 1_000, 1_000 + TRACE_FRESH_MS - 1)).toBe("clean");
  });
  it("does not trace an idle or unknown workspace", async () => {
    expect(await freshTrace(trace, "ws", 0, TRACE_FRESH_MS + 61_000)).toMatch(/^not traced \(idle 6 min/);
    expect(await freshTrace(trace, "ws", null, 5)).toMatch(/^not traced \(no recent activity known/);
  });
  it("the clock keeps the latest activity of a set of agents", () => {
    let now = 10;
    const clock = new ActivityClock(() => now);
    clock.touch("a");
    now = 20;
    clock.touch("b");
    expect(clock.latest(["a", "b"])).toBe(20);
    expect(clock.latest(["c"])).toBeNull();
    clock.forget("b");
    expect(clock.latest(["a", "b"])).toBe(10);
  });
});

describe("worktreeCheck", () => {
  it("passes a worktree that answers", async () => {
    expect(await worktreeCheck(fakePaseo(["true", "abc1234"]).paseo, "ws", 2_000)).toEqual({ ok: true, detail: "worktree at abc1234" });
  });
  it("fails a directory that is not a worktree, or no answer in time", async () => {
    expect((await worktreeCheck(fakePaseo(["fatal: not a git repository"]).paseo, "ws", 2_000)).ok).toBe(false);
    expect(await worktreeCheck(fakePaseo(null).paseo, "ws", 600)).toEqual({ ok: false, detail: "git gave no answer (1 s)" });
  });
});

describe("worktreeCheck on a cold pod (bp-d7d12fbe: the 60 s ran from spawn, during the pod boot)", () => {
  afterEach(() => void vi.useRealTimers());

  it("a pod that boots in 3 min then answers git passes: the 60 s start once the workspace is up", async () => {
    vi.useFakeTimers();
    const { paseo, killed } = fakePaseo(["true", "abc1234"], 180_000);
    const out = worktreeCheck(paseo, "ws", 60_000);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(await out).toEqual({ ok: true, detail: "worktree at abc1234" });
    expect(killed).toHaveLength(1);
  });

  it("a real git hang after the pod is up still fails, 60 s after it came up", async () => {
    vi.useFakeTimers();
    const { paseo } = fakePaseo(null, 180_000);
    let done: { ok: boolean; detail: string; unchecked?: boolean } | null = null;
    void worktreeCheck(paseo, "ws", 60_000).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(230_000);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(done).toEqual({ ok: false, detail: "git gave no answer (60 s)" });
  });

  it("a terminal that cannot be opened yet is retried within the boot grace", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const paseo = {
      terminals: {
        create: async () => {
          if (++calls < 3) throw new Error("pod not ready");
          return { capture: async () => ({ lines: ["FACTORY_TRACE_BEGIN", "true", "abc", "FACTORY_TRACE_END"] }), kill: async () => undefined };
        },
      },
    } as unknown as Paseo;
    const out = worktreeCheck(paseo, "ws", 60_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await out).toEqual({ ok: true, detail: "worktree at abc" });
    expect(calls).toBe(3);
  });

  it("a workspace still not up after the boot grace is unchecked, not a failure, and its late terminal is killed", async () => {
    vi.useFakeTimers();
    const { paseo, killed } = fakePaseo(["true", "abc"], 700_000);
    const out = worktreeCheck(paseo, "ws", 60_000, 600_000);
    await vi.advanceTimersByTimeAsync(600_001);
    expect(await out).toEqual({ ok: false, unchecked: true, detail: "workspace not up after 600 s" });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(killed).toHaveLength(1);
  });
});
