// A small 5-field cron (minute hour day-of-month month day-of-week) with `*`, lists, ranges and steps, matched against the
// wall clock of an IANA time zone. Day of week is 0-7 (0 and 7 are Sunday). As in Vixie cron, when both day fields are
// restricted a day matches if either does.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

export interface WallClock {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  /** 0 = Sunday. */
  dow: number;
  /** `YYYY-MM-DDTHH:MM` in the zone. */
  key: string;
}

const FIELDS: { name: string; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

function parseField(text: string, f: { name: string; min: number; max: number }): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${f.name}: "${part}" is not a value, range or step`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let lo = f.min;
    let hi = f.max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      // `5/15` means from 5 to the end in steps of 15.
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? f.max : lo;
    }
    if (step < 1) throw new Error(`cron ${f.name}: step must be at least 1`);
    if (lo < f.min || hi > f.max || lo > hi) throw new Error(`cron ${f.name}: "${part}" is outside ${f.min}-${f.max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parses a 5-field cron expression; throws with a readable message when it is not one. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" must have 5 fields (minute hour day-of-month month day-of-week)`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!));
  if (dow!.has(7)) dow!.add(0);
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow!, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

export function cronMatches(c: Cron, w: WallClock): boolean {
  if (!c.minute.has(w.minute) || !c.hour.has(w.hour) || !c.month.has(w.month)) return false;
  const domOk = c.dom.has(w.dom);
  const dowOk = c.dow.has(w.dow);
  if (c.domAny || c.dowAny) return domOk && dowOk;
  return domOk || dowOk;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Throws a RangeError for an unknown time zone. */
export function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock fields of an instant in a time zone. */
export function wallClock(ms: number, timeZone: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return {
    minute: Number(parts.minute),
    hour,
    dom: Number(parts.day),
    month: Number(parts.month),
    dow: WEEKDAYS.indexOf(parts.weekday!),
    key: `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:${parts.minute}`,
  };
}

export const MINUTE_MS = 60_000;
export const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
/** The slot name of a minute: its UTC ISO minute, `2026-10-29T08:00Z`. */
export const isoMinute = (ms: number) => `${new Date(floorMinute(ms)).toISOString().slice(0, 16)}Z`;

/** The latest minute in [from, to] (epoch ms, inclusive) whose wall clock in `timeZone` matches. */
export function latestMatch(c: Cron, timeZone: string, from: number, to: number): { at: number; wall: WallClock } | null {
  for (let m = floorMinute(to); m >= from; m -= MINUTE_MS) {
    const wall = wallClock(m, timeZone);
    if (cronMatches(c, wall)) return { at: m, wall };
  }
  return null;
}

/** How far ahead `nextMatch` looks before it gives up (a cron like `0 0 30 2 *` never matches). */
const HORIZON_MS = 400 * 24 * 3600_000;

/**
 * The first minute strictly after `after` whose wall clock in `timeZone` matches, or null within about a year. It skips a
 * whole day when the day does not match and a whole hour when the hour does not, so it stays cheap for the Crons tab.
 */
export function nextMatch(c: Cron, timeZone: string, after: number): number | null {
  const end = after + HORIZON_MS;
  let m = floorMinute(after) + MINUTE_MS;
  while (m <= end) {
    const w = wallClock(m, timeZone);
    const dayOk = c.month.has(w.month) && (c.domAny || c.dowAny ? c.dom.has(w.dom) && c.dow.has(w.dow) : c.dom.has(w.dom) || c.dow.has(w.dow));
    if (!dayOk) m += Math.max(1, 24 * 60 - (w.hour * 60 + w.minute)) * MINUTE_MS;
    else if (!c.hour.has(w.hour)) m += Math.max(1, 60 - w.minute) * MINUTE_MS;
    else if (!c.minute.has(w.minute)) m += MINUTE_MS;
    else return m;
  }
  return null;
}
