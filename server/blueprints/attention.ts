// One mail to the events address per new attention point (human decision f45ab3ba): what the Overview shows as
// "needs a look" (runs paused, failed, waiting for the PM or stalled) and the Inbox's pending items. Suspended runs
// are held on purpose and never count. A point is mailed once; it can be mailed again only after it went away.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Run } from "./store";

export const STALLED_MS = 30 * 60_000;
const FAILED_WINDOW_MS = 24 * 3600_000;

export interface AttentionPoint {
  key: string;
  subject: string;
  body: string;
}

export interface PendingItem {
  id: string;
  agentId: string;
  question: string;
  createdAt: number;
}

const label = (run: Run) => `${run.blueprint} ${run.vars.ticket || run.vars.incident_id || run.id}`;

/** The attention points of the runs and the pending Inbox items. Pure. */
export function attentionPoints(runs: Run[], pending: PendingItem[], now: number): AttentionPoint[] {
  const out: AttentionPoint[] = [];
  for (const run of runs) {
    if (run.status === "suspended" || run.suspended) continue;
    const at = run.stage ?? "?";
    const point = (reason: string, what: string) =>
      out.push({ key: `run:${run.id}:${reason}:${at}`, subject: `Factory: ${label(run)} ${what}`, body: `Run ${run.id} (${label(run)}) ${what} at stage ${at}: ${run.error ?? run.pm.pending?.reason ?? run.waitingFor ?? "no detail"}` });
    const escalated = Object.keys(run.escalations ?? {}).length > 0; // its Inbox item is the point
    if (run.status === "failed") {
      if (now - (run.endedAt ?? now) < FAILED_WINDOW_MS) point("failed", "failed");
    } else if (run.endedAt !== null) continue;
    else if (run.pm.pending) point("pm", "waits for a PM judgement");
    else if (run.status === "paused" && !escalated) point("paused", "is paused");
    else if (run.status === "running" && now - run.updatedAt > STALLED_MS) point("stalled", `has not moved for ${Math.round((now - run.updatedAt) / 60_000)} min`);
  }
  for (const item of pending) {
    out.push({ key: `inbox:${item.id}`, subject: `Factory: Inbox item ${item.id.slice(0, 8)} waits for an answer`, body: `${item.question}\nAsked by ${item.agentId}. Answer it in the Inbox (inbox_pending / inbox_answer).` });
  }
  return out;
}

/** Remembers which points were mailed, in a small JSON file, so a restart does not mail them again. */
export class AttentionNotifier {
  private sent: Set<string> | null = null;

  constructor(
    private readonly file: string,
    private readonly mail: (point: AttentionPoint) => Promise<void>,
  ) {}

  private load(): { sent: Set<string>; fresh: boolean } {
    if (this.sent) return { sent: this.sent, fresh: false };
    let fresh = !existsSync(this.file);
    try {
      this.sent = fresh ? new Set() : new Set(JSON.parse(readFileSync(this.file, "utf8")) as string[]);
    } catch {
      this.sent = new Set();
      fresh = true;
    }
    return { sent: this.sent, fresh };
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.sent!]));
    renameSync(tmp, this.file);
  }

  /** Mails the points not mailed yet and forgets the ones that went away. The first tick ever only records (no backlog flood). */
  async tick(points: AttentionPoint[]): Promise<AttentionPoint[]> {
    const { sent, fresh } = this.load();
    const now = new Set(points.map((p) => p.key));
    let changed = false;
    for (const key of [...sent]) if (!now.has(key)) (sent.delete(key), (changed = true));
    const mailed: AttentionPoint[] = [];
    for (const p of points) {
      if (sent.has(p.key)) continue;
      if (!fresh) {
        try {
          await this.mail(p);
        } catch (error) {
          console.error(`blueprints: attention mail for ${p.key} failed`, error);
          continue; // try again next tick
        }
        mailed.push(p);
      }
      sent.add(p.key);
      changed = true;
    }
    if (changed || fresh) this.save();
    return mailed;
  }
}
