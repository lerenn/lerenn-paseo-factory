import { describe, expect, it } from "vitest";
import { digestMessage, nextDigest } from "./digest";
import { restartAllowed } from "./state";

const MIN = 60_000;

describe("nextDigest", () => {
  it("tells new issues once, repeats an open one after the delay, forgets closed ones", () => {
    const a = { key: "run:1", text: "run 1 is stuck" };
    const b = { key: "ext:x", text: "x is unreachable" };
    let r = nextDigest([a, b], {}, 0, 30 * MIN);
    expect(r.send.map((i) => i.key)).toEqual(["run:1", "ext:x"]);
    r = nextDigest([a, b], r.told, 10 * MIN, 30 * MIN);
    expect(r.send).toEqual([]);
    r = nextDigest([a], r.told, 31 * MIN, 30 * MIN);
    expect(r.send.map((i) => i.key)).toEqual(["run:1"]);
    expect(Object.keys(r.told)).toEqual(["run:1"]);
    r = nextDigest([a, b], r.told, 32 * MIN, 30 * MIN);
    expect(r.send.map((i) => i.key)).toEqual(["ext:x"]); // came back: told again
  });

  it("writes a message the Supervisor can act on", () => {
    expect(digestMessage([{ key: "k", text: "run bp-1 paused" }])).toMatch(/Factory digest \(1 issue/);
  });
});

describe("restartAllowed", () => {
  it("allows one restart per extension per hour", () => {
    const restarts = [{ extension: "release-trains", at: 0 }];
    expect(restartAllowed(restarts, "release-trains", 59 * MIN)).toEqual({ ok: false, minutesAgo: 59 });
    expect(restartAllowed(restarts, "release-trains", 61 * MIN)).toEqual({ ok: true });
    expect(restartAllowed(restarts, "tickets-dispatcher", 5 * MIN)).toEqual({ ok: true });
  });
});
