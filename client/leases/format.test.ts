import { describe, expect, it } from "vitest";
import { inTime } from "./format";

describe("inTime", () => {
  it("formats the time left", () => {
    expect(inTime(1000, 1000)).toBe("expired");
    expect(inTime(0, 30_000)).toBe("in 30 s");
    expect(inTime(0, 10 * 60_000)).toBe("in 10 min");
    expect(inTime(0, 5 * 3600_000)).toBe("in 5 h");
  });
});
