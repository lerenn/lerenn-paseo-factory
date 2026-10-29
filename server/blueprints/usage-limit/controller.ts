// Provider usage limits: the hold of the whole Factory, its audit log and the non-LLM resume scheduler (decision f007d95a,
// accepted b05f2c5c). The state lives in usage-limit.json, outside any run, so a restart keeps it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyUsageLimit, errorSignature, type Classification, type ProviderFailure, type UsageLimitAudit, type UsageLimitStatus } from "../../../shared/blueprints/usage-limit";
import type { UsageLimitSettings } from "../../../shared/blueprints/settings";
import type { UsageLimitHook } from "../engine";
import type { Run, UsageLimitHold } from "../store";

const AUDIT_MAX = 500;
const ALERTED_MAX = 500;
const MATCHES_MAX = 50;
/** A first match is confirmed by a probe this soon. */
export const CONFIRM_PROBE_DELAY_MS = 30_000;
/** At most one probe this often. */
export const PROBE_MIN_GAP_MS = 5 * 60_000;
/** Resume a little after the announced reset. */
export const RESET_MARGIN_MS = 60_000;

export interface GlobalHold {
  since: number;
  provider: string | null;
  rule: string;
  evidence: string;
  resetAt: number | null;
  /** When the scheduler probes to resume. */
  resumeAt: number;
  /** What confirmed it: "probe" or "match from <agent> (run <id>)". */
  confirmedBy: string;
  /** Probes that found the limit still there (back-off step). */
  failedProbes: number;
}

interface Match {
  at: number;
  runId: string;
  agentId: string | null;
  provider: string | null;
  rule: string;
  evidence: string;
  resetAt: number | null;
}

export interface UsageLimitData {
  version: 1;
  hold: GlobalHold | null;
  matches: Match[];
  audit: UsageLimitAudit[];
  /** Signatures of unclassified errors already alerted. */
  alerted: string[];
  probe: { dueAt: number | null; lastAt: number | null; purpose: "confirm" | "resume" | null };
  /** Held runs still to resume, a batch at `nextAt`. */
  resuming: { queue: string[]; nextAt: number } | null;
}

const empty = (): UsageLimitData => ({ version: 1, hold: null, matches: [], audit: [], alerted: [], probe: { dueAt: null, lastAt: null, purpose: null }, resuming: null });

/** usage-limit.json in the Factory's data folder, written atomically. */
export class UsageLimitFile {
  constructor(readonly file: string | null) {}

  load(): UsageLimitData {
    try {
      if (this.file && existsSync(this.file)) {
        const s = JSON.parse(readFileSync(this.file, "utf8")) as UsageLimitData;
        if (s && s.version === 1) return { ...empty(), ...s, probe: { ...empty().probe, ...s.probe } };
      }
    } catch (error) {
      console.error(`usage-limit: unreadable state ${this.file}, starting fresh: ${(error as Error).message}`);
    }
    return empty();
  }

  save(s: UsageLimitData): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

export type ProbeOutcome = { result: "ok" } | { result: "limited"; c: Extract<Classification, { kind: "usage_limit" }> } | { result: "inconclusive"; detail: string };

export interface ControllerPorts {
  now(): number;
  settings(): UsageLimitSettings;
  runs(): Run[];
  /** A person's Factory-wide suspension is on: the scheduler resumes nothing. */
  factorySuspended(): boolean;
  suspend(runId: string, input: { reason: string; by: string; usageLimit: UsageLimitHold }): Promise<unknown>;
  unsuspend(runId: string, input: { note?: string }): Promise<unknown>;
  /** One short turn of a throw-away agent on the provider; absent: probes are inconclusive. */
  probe?(provider: string | null): Promise<{ kind: "completed" | "failed" | "canceled"; message?: string; code?: string } | null>;
  /** Agents Mail; `to` as configured ("supervisor" is resolved by the port). */
  report?(to: string, r: { subject: string; body: string; kind: string }): Promise<void>;
  log(line: string): void;
}

const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : "unknown");

export class UsageLimits implements UsageLimitHook {
  private data: UsageLimitData;
  private probing = false;

  constructor(
    private readonly file: UsageLimitFile,
    private readonly ports: ControllerPorts,
  ) {
    this.data = file.load();
  }

  private save(): void {
    try {
      this.file.save(this.data);
    } catch (error) {
      console.error("usage-limit: saving state failed", error);
    }
  }

  private audit(e: Omit<UsageLimitAudit, "at"> & { at?: number }): void {
    this.data.audit.push({ at: e.at ?? this.ports.now(), ...e } as UsageLimitAudit);
    if (this.data.audit.length > AUDIT_MAX) this.data.audit.splice(0, this.data.audit.length - AUDIT_MAX);
  }

  // ---- the engine's hook ----

  enabled(): boolean {
    return !!this.ports.settings().enabled;
  }

  classify(f: ProviderFailure): Classification {
    return classifyUsageLimit(f, this.ports.now(), this.ports.settings().resetZone || "UTC");
  }

  resumeAtFor(resetAt: number | null): number {
    return resetAt ? resetAt + RESET_MARGIN_MS : this.ports.now() + this.backoffMs(0);
  }

  globalHold(): { reason: string; resumeAt: number | null } | null {
    const h = this.data.hold;
    return h ? { reason: `${h.provider ?? "provider"} ${h.rule}`, resumeAt: h.resumeAt } : null;
  }

  matched(e: { runId: string; agentId: string | null; provider: string | null; rule: string; evidence: string; resetAt: number | null }): void {
    const now = this.ports.now();
    const s = this.ports.settings();
    this.audit({ event: "run_paused", by: "factory", runId: e.runId, agentId: e.agentId, provider: e.provider, rule: e.rule, evidence: e.evidence, resetAt: e.resetAt });
    this.ports.log(`usage-limit: run ${e.runId} paused (${e.rule}) by agent ${e.agentId ?? "?"}`);
    const windowMs = s.confirmMinutes * 60_000;
    this.data.matches = this.data.matches.filter((m) => now - m.at <= Math.max(windowMs, 3600_000)).slice(-MATCHES_MAX);
    const other = this.data.matches.find((m) => now - m.at <= windowMs && m.runId !== e.runId && m.agentId !== e.agentId);
    this.data.matches.push({ at: now, ...e });
    if (this.data.hold) {
      // Already held: a later reset time pushes the resume.
      if (e.resetAt && e.resetAt + RESET_MARGIN_MS > this.data.hold.resumeAt) this.data.hold.resumeAt = e.resetAt + RESET_MARGIN_MS;
      this.save();
      return;
    }
    if (other) {
      this.save();
      void this.engage({ ...e, resetAt: maxNullable(e.resetAt, other.resetAt) }, `match from agent ${other.agentId ?? "?"} (run ${other.runId})`);
      return;
    }
    // One match holds only its run; a probe confirms (or not) soon.
    const last = this.data.probe.lastAt;
    const due = Math.max(now + CONFIRM_PROBE_DELAY_MS, last ? last + PROBE_MIN_GAP_MS : 0);
    if (this.data.probe.dueAt === null || due < this.data.probe.dueAt) this.data.probe = { ...this.data.probe, dueAt: due, purpose: "confirm" };
    this.save();
  }

  unknown(e: { runId: string; agentId: string | null; failure: ProviderFailure }): void {
    const sig = errorSignature(`${e.failure.code ? `${e.failure.code} ` : ""}${e.failure.message}`);
    if (!sig || this.data.alerted.includes(sig)) return;
    this.data.alerted.push(sig);
    if (this.data.alerted.length > ALERTED_MAX) this.data.alerted.splice(0, this.data.alerted.length - ALERTED_MAX);
    const to = this.ports.settings().unknownAlertTo?.trim();
    this.audit({ event: "unknown_alert", by: "factory", runId: e.runId, agentId: e.agentId, provider: e.failure.provider ?? null, evidence: sig, note: to ? `mailed ${to}` : "logged only" });
    this.save();
    this.ports.log(`usage-limit: unclassified provider error (run ${e.runId}): ${sig}`);
    if (to && this.ports.report) {
      void this.ports
        .report(to, {
          subject: "Factory: an unclassified provider error",
          body:
            `Run ${e.runId}, agent ${e.agentId ?? "?"}, provider ${e.failure.provider ?? "?"}: a failed turn the usage-limit classifier does not know. It took the normal path (attempts and flakes).\n` +
            `code: ${e.failure.code ?? "none"}\nmessage: ${e.failure.message.slice(0, 500)}\n\n` +
            "Told once per kind of error. If it is a usage limit, add it as a fixture and a rule to shared/blueprints/usage-limit.ts; if not, as a negative case.",
          kind: "notice",
        })
        .catch((error) => console.error("usage-limit: alert mail failed", error));
    }
  }

  // ---- the hold of the whole Factory ----

  private async engage(e: { provider: string | null; rule: string; evidence: string; resetAt: number | null; runId?: string }, confirmedBy: string): Promise<void> {
    if (this.data.hold) return;
    const now = this.ports.now();
    this.data.hold = { since: now, provider: e.provider, rule: e.rule, evidence: e.evidence, resetAt: e.resetAt, resumeAt: e.resetAt ? e.resetAt + RESET_MARGIN_MS : now + this.backoffMs(0), confirmedBy, failedProbes: 0 };
    this.data.probe = { ...this.data.probe, dueAt: null, purpose: null };
    this.data.resuming = null;
    const live = this.ports.runs().filter((r) => r.status === "running" || r.status === "waiting" || r.status === "paused");
    const held = this.heldRuns().map((r) => r.id);
    this.audit({ event: "global_paused", by: "factory", provider: e.provider, rule: e.rule, evidence: e.evidence, resetAt: e.resetAt, runs: [...held, ...live.map((r) => r.id)], note: `confirmed by ${confirmedBy}` });
    this.save();
    this.ports.log(`usage-limit: Factory paused (${e.rule}), confirmed by ${confirmedBy}; resume at ${iso(this.data.hold.resumeAt)}`);
    for (const run of live) {
      await this.ports
        .suspend(run.id, { reason: `paused: quota (Factory-wide, ${e.rule})`, by: "factory", usageLimit: { source: "global", rule: e.rule, evidence: e.evidence, provider: e.provider, agentId: null, resetAt: e.resetAt, resumeAt: null } })
        .catch((error) => console.error(`usage-limit: holding ${run.id} failed`, error));
    }
    this.notify("paused");
  }

  /** Clear the hold and resume every run held for a usage limit, in staggered batches. */
  private release(by: string, event: "resumed" | "lifted", note: string): string[] {
    const now = this.ports.now();
    const queue = this.heldRuns()
      .sort((a, b) => (a.suspended?.at ?? 0) - (b.suspended?.at ?? 0))
      .map((r) => r.id);
    const hold = this.data.hold;
    this.data.hold = null;
    this.data.probe = { ...this.data.probe, dueAt: null, purpose: null };
    this.data.resuming = queue.length ? { queue, nextAt: now } : null;
    this.audit({ event, by, provider: hold?.provider ?? null, rule: hold?.rule ?? null, runs: queue, note });
    this.save();
    this.ports.log(`usage-limit: ${event} by ${by} (${note}); ${queue.length} run(s) to resume`);
    if (hold || event === "lifted") this.notify(event, queue);
    return queue;
  }

  /** A person lifts the pause (UI or a trusted agent): no probe first. */
  lift(by: string): { ok: boolean; message: string } {
    if (!this.data.hold && this.heldRuns().length === 0) return { ok: false, message: "Nothing is held for a usage limit." };
    const queue = this.release(by, "lifted", "lifted by a person");
    void this.tick();
    return { ok: true, message: `Pause lifted; ${queue.length} run(s) resume, ${this.ports.settings().resumeConcurrency} every ${this.ports.settings().resumeStaggerSeconds} s.` };
  }

  // ---- the scheduler (no model calls) ----

  private backoffMs(step: number): number {
    const base = Math.max(1, this.ports.settings().probeMinutes);
    return [base, Math.max(base, 10), Math.max(base, 15), Math.max(base, 30)][Math.min(step, 3)] * 60_000;
  }

  /** Runs held for a usage limit (own or global). */
  heldRuns(): Run[] {
    return this.ports.runs().filter((r) => r.status === "suspended" && !!r.suspended?.usageLimit);
  }

  async tick(): Promise<void> {
    if (this.ports.factorySuspended()) return; // a person stopped the Factory: nothing resumes on its own
    const now = this.ports.now();
    const s = this.ports.settings();
    if (this.enabled()) await this.schedule(now);
    // Batches of a resume in progress.
    const r = this.data.resuming;
    if (r && now >= r.nextAt && !this.data.hold) {
      const batch = r.queue.splice(0, Math.max(1, s.resumeConcurrency));
      r.nextAt = now + s.resumeStaggerSeconds * 1000;
      if (r.queue.length === 0) this.data.resuming = null;
      this.save();
      for (const id of batch) {
        const run = this.ports.runs().find((x) => x.id === id);
        if (!run || run.status !== "suspended" || !run.suspended?.usageLimit) continue;
        await this.ports.unsuspend(id, { note: undefined }).catch((error) => console.error(`usage-limit: resuming ${id} failed`, error));
        this.audit({ event: "run_resumed", by: "factory", runId: id });
      }
      if (batch.length) this.save();
    }
  }

  private async schedule(now: number): Promise<void> {
    // Probes: to confirm a first match, or to resume the Factory at its resume time.
    if (this.data.hold && now >= this.data.hold.resumeAt && this.data.probe.purpose !== "resume") this.data.probe = { ...this.data.probe, dueAt: now, purpose: "resume" };
    if (this.data.probe.dueAt !== null && now >= this.data.probe.dueAt && !this.probing) await this.runProbe(this.data.probe.purpose ?? "confirm");
    // Runs held on their own match (no Factory hold) resume at their own time.
    if (!this.data.hold) {
      const due = this.heldRuns().filter((x) => x.suspended!.usageLimit!.source === "own" && (x.suspended!.usageLimit!.resumeAt ?? 0) <= now).map((x) => x.id);
      const queued = new Set(this.data.resuming?.queue ?? []);
      const add = due.filter((id) => !queued.has(id));
      if (add.length) {
        this.data.resuming = { queue: [...(this.data.resuming?.queue ?? []), ...add], nextAt: this.data.resuming?.nextAt ?? now };
        this.save();
      }
    }
  }

  private async runProbe(purpose: "confirm" | "resume"): Promise<void> {
    this.probing = true;
    const now = this.ports.now();
    this.data.probe = { dueAt: null, lastAt: now, purpose: null };
    this.save();
    const provider = this.data.hold?.provider ?? this.data.matches.at(-1)?.provider ?? null;
    let out: ProbeOutcome;
    try {
      const turn = this.ports.probe ? await this.ports.probe(provider) : null;
      if (!turn) out = { result: "inconclusive", detail: "no probe" };
      else if (turn.kind === "completed") out = { result: "ok" };
      else {
        const c = turn.kind === "failed" ? this.classify({ message: turn.message ?? "", code: turn.code ?? null, provider }) : null;
        out = c?.kind === "usage_limit" ? { result: "limited", c } : { result: "inconclusive", detail: `${turn.kind}: ${(turn.message ?? "").slice(0, 200)}` };
      }
    } catch (error) {
      out = { result: "inconclusive", detail: (error as Error).message.slice(0, 200) };
    } finally {
      this.probing = false;
    }
    this.audit({ event: "probe", by: "factory", provider, rule: out.result === "limited" ? out.c.rule : null, evidence: out.result === "limited" ? out.c.evidence : null, resetAt: out.result === "limited" ? out.c.resetAt : null, note: `${purpose}: ${out.result}${out.result === "inconclusive" ? ` (${out.detail})` : ""}` });
    this.ports.log(`usage-limit: ${purpose} probe ${out.result}`);
    if (purpose === "confirm") {
      if (out.result === "limited" && !this.data.hold) {
        const last = this.data.matches.at(-1);
        await this.engage({ provider, rule: last?.rule ?? out.c.rule, evidence: last?.evidence ?? out.c.evidence, resetAt: maxNullable(out.c.resetAt, last?.resetAt ?? null) }, "probe");
      } else this.save();
      return;
    }
    const hold = this.data.hold;
    if (!hold) return this.save();
    if (out.result === "ok") {
      this.release("factory", "resumed", "probe passed");
      return;
    }
    hold.failedProbes += 1;
    hold.resumeAt = out.result === "limited" && out.c.resetAt ? out.c.resetAt + RESET_MARGIN_MS : this.ports.now() + this.backoffMs(hold.failedProbes);
    if (out.result === "limited" && out.c.resetAt) hold.resetAt = out.c.resetAt;
    this.save();
  }

  // ---- notifications ----

  private notify(event: "paused" | "resumed" | "lifted", resumed: string[] = []): void {
    const targets = this.ports.settings().notify ?? [];
    if (!targets.length || !this.ports.report) return;
    const st = this.status();
    const runs = event === "paused" ? st.runs.map((r) => r.runId) : resumed;
    const agents = event === "paused" ? st.agents : [];
    const subject = event === "paused" ? `Factory paused: provider usage limit (${st.provider ?? "provider"})` : event === "resumed" ? "Factory resumed after the usage limit" : "Factory usage-limit pause lifted by a person";
    const body = [
      event === "paused"
        ? `The Factory holds every run: ${st.rule ?? "usage limit"} (${st.confirmedBy ? `confirmed by ${st.confirmedBy}` : "confirmed"}). Evidence: ${st.evidence ?? "none"}`
        : `The hold is cleared; held runs resume in batches of ${this.ports.settings().resumeConcurrency} every ${this.ports.settings().resumeStaggerSeconds} s.`,
      event === "paused" ? `resume_at: ${iso(st.resumeAt)} (then a probe; a person can lift it in Blueprints > Quota)` : "",
      `runs: ${runs.join(", ") || "none"}`,
      agents.length ? `agents: ${agents.join(", ")}` : "",
      event === "paused"
        ? "Agents outside the Factory: wait. Check usage_limit_status if this mail is late."
        : "Agents outside the Factory: send \"continue\" one by one, staggered, to those whose last error usage_limit_classify accepts or that were cut mid-turn while the hold was on.",
    ]
      .filter(Boolean)
      .join("\n");
    for (const to of targets) {
      void this.ports.report(to, { subject, body, kind: "notice" }).catch((error) => console.error(`usage-limit: mail to ${to} failed`, error));
    }
  }

  // ---- reads ----

  status(): UsageLimitStatus {
    const h = this.data.hold;
    const held = this.heldRuns();
    return {
      now: this.ports.now(),
      enabled: this.enabled(),
      state: h ? "paused" : held.length ? "run_holds" : "clear",
      since: h?.since ?? (held.length ? Math.min(...held.map((r) => r.suspended!.at)) : null),
      resumeAt: h?.resumeAt ?? (held.length ? Math.min(...held.map((r) => r.suspended!.usageLimit!.resumeAt ?? Infinity)) : null),
      provider: h?.provider ?? held[0]?.suspended?.usageLimit?.provider ?? null,
      rule: h?.rule ?? held[0]?.suspended?.usageLimit?.rule ?? null,
      evidence: h?.evidence ?? held[0]?.suspended?.usageLimit?.evidence ?? null,
      confirmedBy: h?.confirmedBy ?? null,
      runs: held.map((r) => {
        const u = r.suspended!.usageLimit!;
        return { runId: r.id, blueprint: r.blueprint, stage: r.stage, agentId: (r.stage ? r.stages[r.stage]?.agentId : null) ?? u.agentId, heldAt: r.suspended!.at, resumeAt: u.source === "global" ? (h?.resumeAt ?? null) : u.resumeAt, source: u.source === "own" ? "own match" : "global hold", rule: u.rule };
      }),
      agents: [...new Set(held.map((r) => (r.stage ? r.stages[r.stage]?.agentId : null) ?? r.suspended!.usageLimit!.agentId).filter((x): x is string => !!x))],
      notify: this.ports.settings().notify ?? [],
      resuming: this.data.resuming?.queue ?? [],
    };
  }

  auditLog(limit = 100): UsageLimitAudit[] {
    return this.data.audit.slice(-limit).reverse();
  }

  snapshot(): UsageLimitData {
    return this.data;
  }
}

function maxNullable(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b);
}
