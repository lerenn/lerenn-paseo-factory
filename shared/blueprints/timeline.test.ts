import { describe, expect, it } from "vitest";
import { buildTimeline, formatDuration } from "./timeline";

const MIN = 60_000;
const ev = (at: number, event: string, stage: string | null = null, detail: string | null = null) => ({ at: at * MIN, event, stage, detail });

describe("buildTimeline", () => {
  it("splits time per stage, with attempts, retries, waiting vs working and verdicts", () => {
    const history = [
      ev(0, "started", "think"),
      ev(0, "enter", "think", "agent run 1"),
      ev(0, "spawned", "think"),
      ev(2, "flake_retry", "think"),
      ev(2, "spawned", "think"),
      ev(10, "verdict", "think", "fix: found it"),
      ev(10, "enter", "criteria", "gate run 1"),
      ev(10, "gate_opened", "criteria", "item-1"),
      ev(40, "gate_answered", "criteria", "approve by human"),
      ev(40, "enter", "build", "agent run 1"),
      ev(40, "spawned", "build"),
      ev(50, "exhausted", "build", "2 attempts used"),
      ev(55, "pm_grant", "build", "2 extra"),
      ev(65, "verdict", "build", "done"),
      ev(65, "done", "build"),
    ];
    const seg = buildTimeline(history, 100 * MIN, 65 * MIN);
    expect(seg.map((s) => s.stage)).toEqual(["think", "criteria", "build"]);
    expect(seg[0]).toMatchObject({ attempts: 2, retries: 1, workingMs: 10 * MIN, waitingMs: 0, verdict: "fix" });
    expect(seg[1]).toMatchObject({ gateOpenedAt: 10 * MIN, gateClosedAt: 40 * MIN, waitingMs: 30 * MIN, workingMs: 0 });
    expect(seg[2]).toMatchObject({ workingMs: 20 * MIN, waitingMs: 5 * MIN, verdict: "done" });
    expect(seg[2].escalations).toEqual(["exhausted: 2 attempts used", "PM granted 2 extra"]);
    expect(seg[2].endedAt).toBe(65 * MIN);
  });

  it("counts entries when a stage is looped through, and closes an open segment at now", () => {
    const seg = buildTimeline([ev(0, "enter", "qa"), ev(5, "verdict", "qa", "fail"), ev(5, "enter", "repair"), ev(9, "verdict", "repair", "done"), ev(9, "enter", "qa"), ev(9, "spawned", "qa")], 20 * MIN);
    expect(seg.map((s) => `${s.stage}#${s.entry}`)).toEqual(["qa#1", "repair#1", "qa#2"]);
    expect(seg[2]).toMatchObject({ endedAt: null, workingMs: 11 * MIN });
  });

  it("formats durations", () => {
    expect([formatDuration(5000), formatDuration(5 * MIN), formatDuration(125 * MIN)]).toEqual(["5s", "5m", "2h05"]);
  });
});
