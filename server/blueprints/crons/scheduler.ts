// One tick: follow the runs the schedules started (a run that ends failed or aborted counts against its schedule, done resets
// the count, maxFailures in a row pause it and mail once), then start each due schedule unless a run of it is still active.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { floorMinute, isoMinute, latestMatch, MINUTE_MS } from "./cron";
import type { Schedule } from "./schedules";

/** At most this many minutes are caught up after a pause of the Factory (the current one included). */
export const CATCH_UP_MINUTES = 10;
/** A started run the store no longer has is forgotten after this long. */
const FORGET_MS = 7 * 24 * 3600_000;
/** A pause mail that cannot be sent is given up after this many ticks. */
const MAIL_TRIES = 5;

export const ENDED = new Set(["done", "failed", "aborted"]);

/** The fields of a run the scheduler reads. */
export interface RunSnapshot {
  id: string;
  status: string;
  vars: Record<string, string>;
}
export const isActive = (run: RunSnapshot) => !ENDED.has(run.status);

export type StartResult = { ok: true; runId: string } | { ok: false; retry: boolean; error: string };

export interface ScheduleState {
  consecutiveFailures: number;
  paused: boolean;
  pausedAt: number | null;
  /** Why it is paused: failures (mailed) or by hand. */
  pausedBy: "failures" | "user" | null;
  /** Mail about the pause still to send, and the tries so far. */
  mailPending: boolean;
  mailTries: number;
  /** The last slot handled (started, skipped or refused), epoch ms of its minute. */
  lastSlot: number | null;
  /** The wall-clock minute of that slot in the schedule's zone: a repeated wall-clock minute (DST) starts nothing. */
  lastWall: string | null;
  /** `enabled` as last seen: false to true resumes a paused schedule. */
  lastEnabled: boolean | null;
  /** Runs started and not yet seen ending. */
  runs: { runId: string; slot: string; startedAt: number }[];
  lastRunId: string | null;
  lastResult: string | null;
}

export interface CronState {
  version: 1;
  /** The last minute evaluated (epoch ms); null before the first tick. */
  lastMinute: number | null;
  schedules: Record<string, ScheduleState>;
}

export const emptySchedule = (): ScheduleState => ({
  consecutiveFailures: 0,
  paused: false,
  pausedAt: null,
  pausedBy: null,
  mailPending: false,
  mailTries: 0,
  lastSlot: null,
  lastWall: null,
  lastEnabled: null,
  runs: [],
  lastRunId: null,
  lastResult: null,
});

/** The scheduler's state as JSON in the Factory's data folder, written atomically. */
export class StateFile {
  constructor(readonly file: string | null) {}

  load(): CronState {
    try {
      if (this.file && existsSync(this.file)) {
        const s = JSON.parse(readFileSync(this.file, "utf8")) as CronState;
        if (s && s.version === 1 && typeof s.schedules === "object") {
          for (const [id, st] of Object.entries(s.schedules)) s.schedules[id] = { ...emptySchedule(), ...st };
          return s;
        }
      }
    } catch (error) {
      console.error(`crons: unreadable state ${this.file}, starting fresh: ${(error as Error).message}`);
    }
    return { version: 1, lastMinute: null, schedules: {} };
  }

  save(s: CronState): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

export interface Ports {
  /** Every run with a `cron_id` var, from the run store. */
  runs(): RunSnapshot[];
  start(input: { blueprint: string; vars: Record<string, string>; requestedBy: string; idempotencyKey: string }): StartResult;
  /** Resolves to null once the mail is sent, else the reason. */
  mail(m: { to: string; subject: string; body: string }): Promise<string | null>;
  log(line: string): void;
}

export class Scheduler {
  private state: CronState;
  private now = 0;

  constructor(
    private readonly store: StateFile,
    private readonly ports: Ports,
  ) {
    this.state = store.load();
  }

  snapshot(): CronState {
    return this.state;
  }

  private of(id: string): ScheduleState {
    return (this.state.schedules[id] ??= emptySchedule());
  }

  /** The active run of a schedule, if any. */
  activeRun(id: string, runs = this.ports.runs()): RunSnapshot | null {
    return runs.find((r) => r.vars?.cron_id === id && isActive(r)) ?? null;
  }

  /** Pauses a schedule by hand (no mail). */
  pause(id: string, now: number): void {
    const st = this.of(id);
    if (!st.paused) this.ports.log(`${id}: paused by hand`);
    st.paused = true;
    st.pausedAt ??= now;
    st.pausedBy ??= "user";
    this.store.save(this.state);
  }

  /** Resumes a paused schedule and clears its failure count. */
  resume(id: string, why: string): void {
    const st = this.of(id);
    if (st.paused) this.ports.log(`${id}: resumed (${why})`);
    Object.assign(st, { paused: false, pausedAt: null, pausedBy: null, mailPending: false, mailTries: 0, consecutiveFailures: 0 });
    this.store.save(this.state);
  }

  /** Starts the schedule now unless a run of it is active. Key `cron:<id>:now:<minute>`. */
  runNow(s: Schedule, now: number): { ok: boolean; runId: string | null; message: string | null } {
    this.now = now;
    const runs = this.ports.runs();
    const active = this.activeRun(s.id, runs);
    if (active) return { ok: false, runId: null, message: `Run ${active.id} of ${s.id} is still ${active.status}; one run at a time.` };
    const slot = isoMinute(now);
    const res = this.ports.start({ blueprint: s.blueprint, vars: { ...s.vars, cron_id: s.id, cron_slot: slot }, requestedBy: `cron:${s.id}`, idempotencyKey: `cron:${s.id}:now:${slot}` });
    if (!res.ok) return { ok: false, runId: null, message: res.error };
    const st = this.of(s.id);
    if (!st.runs.some((r) => r.runId === res.runId)) st.runs.push({ runId: res.runId, slot, startedAt: now });
    st.lastRunId = res.runId;
    this.ports.log(`${s.id}: run now started ${s.blueprint} run ${res.runId}`);
    this.store.save(this.state);
    return { ok: true, runId: res.runId, message: null };
  }

  async tick(schedules: Schedule[], now: number, defaultMailTo: string): Promise<void> {
    this.now = now;
    const byId = new Map(schedules.map((s) => [s.id, s]));
    for (const s of schedules) {
      const st = this.of(s.id);
      if (st.lastEnabled === false && s.enabled && st.paused) this.resume(s.id, "enabled again");
      st.lastEnabled = s.enabled;
    }

    const runs = this.ports.runs();
    this.follow(runs, byId, now);

    const nowMin = floorMinute(now);
    const from = Math.max(nowMin - (CATCH_UP_MINUTES - 1) * MINUTE_MS, this.state.lastMinute === null ? nowMin : this.state.lastMinute + MINUTE_MS);
    let complete = true;
    for (const s of schedules) {
      const st = this.of(s.id);
      if (!s.enabled || st.paused) continue;
      // A slot already handled is never handled again; the window starts after the last minute evaluated.
      const lo = Math.max(from, st.lastSlot === null ? -Infinity : st.lastSlot + MINUTE_MS);
      const hit = lo <= nowMin ? latestMatch(s.parsed, s.timezone, lo, nowMin) : null;
      if (!hit) continue;
      const { at, wall } = { at: hit.at, wall: hit.wall.key };
      const slot = isoMinute(at);
      if (st.lastWall === wall) {
        st.lastSlot = at;
        continue;
      }
      const active = this.activeRun(s.id, runs);
      if (active) {
        this.ports.log(`${s.id}: slot ${slot} skipped, run ${active.id} is still ${active.status}`);
        st.lastSlot = at;
        st.lastWall = wall;
        continue;
      }
      const res = this.ports.start({
        blueprint: s.blueprint,
        vars: { ...s.vars, cron_id: s.id, cron_slot: slot },
        requestedBy: `cron:${s.id}`,
        idempotencyKey: `cron:${s.id}:${slot}`,
      });
      if (res.ok) {
        this.ports.log(`${s.id}: slot ${slot} started ${s.blueprint} run ${res.runId}`);
        if (!st.runs.some((r) => r.runId === res.runId)) st.runs.push({ runId: res.runId, slot, startedAt: now });
        st.lastRunId = res.runId;
        st.lastSlot = at;
        st.lastWall = wall;
      } else if (res.retry) {
        this.ports.log(`${s.id}: slot ${slot} not started yet: ${res.error}`);
        complete = false;
      } else {
        this.ports.log(`${s.id}: slot ${slot} refused: ${res.error}`);
        st.lastSlot = at;
        st.lastWall = wall;
        this.outcome(s, st, `refused: ${res.error}`, null);
      }
    }
    await this.sendPending(byId, defaultMailTo);
    if (complete) this.state.lastMinute = nowMin;
    this.store.save(this.state);
  }

  /** Counts the runs that ended since the last look. */
  private follow(runs: RunSnapshot[], byId: Map<string, Schedule>, now: number): void {
    const index = new Map(runs.map((r) => [r.id, r]));
    for (const [id, st] of Object.entries(this.state.schedules)) {
      st.runs = st.runs.filter((t) => {
        const r = index.get(t.runId);
        if (!r) return now - t.startedAt < FORGET_MS;
        if (isActive(r)) return true;
        this.outcome(byId.get(id), st, r.status, r.id, id);
        return false;
      });
    }
  }

  private outcome(s: Schedule | undefined, st: ScheduleState, status: string, runId: string | null, id = s?.id ?? "?"): void {
    st.lastResult = status;
    if (runId) st.lastRunId = runId;
    if (status === "done") {
      st.consecutiveFailures = 0;
      return;
    }
    st.consecutiveFailures += 1;
    this.ports.log(`${id}: ${runId ?? "start"} ${status}, ${st.consecutiveFailures} failure(s) in a row`);
    const max = s?.maxFailures ?? 2;
    if (!st.paused && st.consecutiveFailures >= max) {
      st.paused = true;
      st.pausedAt = this.now;
      st.pausedBy = "failures";
      st.mailPending = true;
      st.mailTries = 0;
      this.ports.log(`${id}: paused after ${st.consecutiveFailures} failures in a row`);
    }
  }

  private async sendPending(byId: Map<string, Schedule>, defaultMailTo: string): Promise<void> {
    for (const [id, st] of Object.entries(this.state.schedules)) {
      if (!st.mailPending) continue;
      const s = byId.get(id);
      const to = (s?.mailTo ?? defaultMailTo).trim();
      if (!to) {
        st.mailPending = false;
        continue;
      }
      const err = await this.ports.mail({
        to,
        subject: `Factory cron ${id} paused after ${st.consecutiveFailures} failed runs in a row`,
        body: [
          `The cron schedule ${id}${s ? ` (${s.cron} ${s.timezone}, blueprint ${s.blueprint})` : ""} is paused: its last ${st.consecutiveFailures} runs ended failed or aborted (last: ${st.lastRunId ? `${st.lastRunId} ` : ""}${st.lastResult ?? "?"}).`,
          "No new run starts until it is resumed: Resume in the Factory's Crons tab, or set its enabled to false and then true again.",
        ].join("\n"),
      });
      st.mailTries += 1;
      if (err === null) {
        st.mailPending = false;
        this.ports.log(`${id}: pause mailed to ${to}`);
      } else if (st.mailTries >= MAIL_TRIES) {
        st.mailPending = false;
        this.ports.log(`${id}: pause not mailed to ${to}, giving up: ${err}`);
      } else {
        this.ports.log(`${id}: pause mail to ${to} not sent yet: ${err}`);
      }
    }
  }
}
