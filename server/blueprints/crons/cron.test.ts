import { describe, expect, it } from "vitest";
import { cronMatches, isoMinute, latestMatch, nextMatch, parseCron, wallClock } from "./cron";

const at = (iso: string) => Date.parse(iso);
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("parseCron", () => {
  it("reads stars, lists, ranges and steps", () => {
    const c = parseCron("*/15 9-17/4 1,15 * 1-5");
    expect(sorted(c.minute)).toEqual([0, 15, 30, 45]);
    expect(sorted(c.hour)).toEqual([9, 13, 17]);
    expect(sorted(c.dom)).toEqual([1, 15]);
    expect(c.month.size).toBe(12);
    expect(sorted(c.dow)).toEqual([1, 2, 3, 4, 5]);
    expect(sorted(parseCron("5/20 * * * *").minute)).toEqual([5, 25, 45]);
    expect(sorted(parseCron("0 0 * * 7").dow)).toEqual([0, 7]);
  });

  it("rejects what is not a 5-field cron", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/outside/);
    expect(() => parseCron("0 9 * * MON")).toThrow(/not a value/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
    expect(() => parseCron("0 9 0 * *")).toThrow(/outside/);
    expect(() => parseCron("0 5-3 * * *")).toThrow(/outside/);
  });
});

describe("wall clock and matching", () => {
  it("reads the wall clock of a time zone, across daylight saving time", () => {
    // 2026-10-29 is a Thursday; Paris is UTC+1 after 2026-10-25.
    expect(wallClock(at("2026-10-29T08:00:00Z"), "Europe/Paris")).toEqual({ minute: 0, hour: 9, dom: 29, month: 10, dow: 4, key: "2026-10-29T09:00" });
    expect(wallClock(at("2026-07-01T07:00:00Z"), "Europe/Paris").hour).toBe(9);
    expect(wallClock(at("2026-10-29T23:30:00Z"), "Europe/Paris").key).toBe("2026-10-30T00:30");
    expect(() => wallClock(0, "Mars/Olympus")).toThrow(RangeError);
  });

  it("matches weekdays at 09:00 Paris only", () => {
    const c = parseCron("0 9 * * 1-5");
    expect(cronMatches(c, wallClock(at("2026-10-29T08:00:00Z"), "Europe/Paris"))).toBe(true);
    expect(cronMatches(c, wallClock(at("2026-10-29T09:00:00Z"), "Europe/Paris"))).toBe(false);
    expect(cronMatches(c, wallClock(at("2026-10-31T08:00:00Z"), "Europe/Paris"))).toBe(false); // Saturday
  });

  it("ORs the day fields when both are restricted", () => {
    const c = parseCron("0 0 13 * 5");
    expect(cronMatches(c, wallClock(at("2026-11-13T00:00:00Z"), "UTC"))).toBe(true); // Friday the 13th
    expect(cronMatches(c, wallClock(at("2026-11-06T00:00:00Z"), "UTC"))).toBe(true); // a Friday
    expect(cronMatches(c, wallClock(at("2026-12-13T00:00:00Z"), "UTC"))).toBe(true); // a Sunday the 13th
    expect(cronMatches(c, wallClock(at("2026-11-07T00:00:00Z"), "UTC"))).toBe(false);
  });

  it("finds the latest matching minute of a window", () => {
    const c = parseCron("*/5 * * * *");
    const hit = latestMatch(c, "UTC", at("2026-10-29T08:00:00Z"), at("2026-10-29T08:09:30Z"))!;
    expect(isoMinute(hit.at)).toBe("2026-10-29T08:05Z");
    expect(latestMatch(parseCron("0 9 * * *"), "UTC", at("2026-10-29T08:00:00Z"), at("2026-10-29T08:09:00Z"))).toBeNull();
  });
});

describe("nextMatch", () => {
  it("finds the next weekday 09:00 Paris, skipping the weekend", () => {
    const c = parseCron("0 9 * * 1-5");
    expect(isoMinute(nextMatch(c, "Europe/Paris", at("2026-10-29T08:00:00Z"))!)).toBe("2026-10-30T08:00Z"); // Thu 09:00 -> Fri
    expect(isoMinute(nextMatch(c, "Europe/Paris", at("2026-10-30T08:30:00Z"))!)).toBe("2026-11-02T08:00Z"); // Fri -> Mon
    expect(isoMinute(nextMatch(c, "Europe/Paris", at("2026-10-29T07:59:00Z"))!)).toBe("2026-10-29T08:00Z");
  });

  it("follows steps and gives up on a day that never comes", () => {
    expect(isoMinute(nextMatch(parseCron("*/15 * * * *"), "UTC", at("2026-10-29T08:01:00Z"))!)).toBe("2026-10-29T08:15Z");
    expect(nextMatch(parseCron("0 0 30 2 *"), "UTC", at("2026-10-29T08:01:00Z"))).toBeNull();
  });
});
