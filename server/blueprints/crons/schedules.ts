import { readFile } from "node:fs/promises";
import { z } from "zod";
import { scheduleEntrySchema, type ScheduleEntry } from "../../../shared/blueprints/crons";
import { formatterFor, parseCron, type Cron } from "./cron";

export interface Schedule extends ScheduleEntry {
  parsed: Cron;
  /** Where the entry comes from: a git source label or "settings". */
  source: string;
}

export interface Parsed {
  schedules: Schedule[];
  /** One line per entry left out, with the reason. */
  errors: string[];
}

/** The file each git source may hold, in its Factory folder next to roles/ and blueprints/. */
export const SCHEDULES_FILE = "crons/schedules.json";

/** Reads entries; a bad one is left out with the reason. `seen` carries ids across sources: the first one wins. */
export function parseEntries(list: unknown[], source: string, seen = new Set<string>()): Parsed {
  const schedules: Schedule[] = [];
  const errors: string[] = [];
  list.forEach((item, i) => {
    const label = `${source}: ${typeof (item as { id?: unknown })?.id === "string" ? (item as { id: string }).id : `#${i}`}`;
    const r = scheduleEntrySchema.safeParse(item);
    if (!r.success) return void errors.push(`${label}: ${z.prettifyError(r.error).replace(/\n/g, " ")}`);
    const s = r.data;
    if (seen.has(s.id)) return void errors.push(`${label}: repeated id, only the first counts`);
    try {
      formatterFor(s.timezone);
    } catch {
      return void errors.push(`${label}: unknown time zone "${s.timezone}"`);
    }
    if ("cron_id" in s.vars || "cron_slot" in s.vars) return void errors.push(`${label}: vars cron_id and cron_slot are set by the Factory`);
    try {
      schedules.push({ ...s, parsed: parseCron(s.cron), source });
      seen.add(s.id);
    } catch (error) {
      errors.push(`${label}: ${(error as Error).message}`);
    }
  });
  return { schedules, errors };
}

/** A schedules file: `{"schedules": [...]}`. Throws when the file itself is not one. */
export function parseSchedulesFile(text: string): unknown[] {
  const list = (JSON.parse(text) as { schedules?: unknown })?.schedules;
  if (!Array.isArray(list)) throw new Error('expected an object with a "schedules" array');
  return list;
}

/**
 * Loads every schedule: the settings' entries first, then each source's file in order. A missing file is no schedule; a
 * file that does not parse keeps the last good copy of that file (`lastGood`, by path) and is reported.
 */
export async function loadSchedules(
  files: { file: string; label: string }[],
  fromSettings: unknown[],
  lastGood: Map<string, unknown[]> = new Map(),
): Promise<Parsed> {
  const seen = new Set<string>();
  const out = parseEntries(fromSettings, "settings", seen);
  for (const { file, label } of files) {
    let list: unknown[] | undefined;
    try {
      list = parseSchedulesFile(await readFile(file, "utf8"));
      lastGood.set(file, list);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        lastGood.delete(file);
        continue;
      }
      list = lastGood.get(file);
      out.errors.push(`${label}: ${(error as Error).message}${list ? " (the last good copy is in use)" : ""}`);
    }
    if (!list) continue;
    const r = parseEntries(list, label, seen);
    out.schedules.push(...r.schedules);
    out.errors.push(...r.errors);
  }
  return out;
}
