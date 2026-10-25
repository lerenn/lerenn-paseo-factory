import type { LeaseMode, LeaseView } from "../../shared/leases/lease";
import type { LeasesSettings } from "../../shared/leases/settings";
import { render } from "./template";
import type { Lease, Store } from "./store";

/** What the engine does to the outside world; the plugin wires it to the Paseo SDK. */
export interface Actions {
  send(agentId: string, text: string): Promise<void>;
  /** True when the agent was archived (or no longer exists). */
  isArchived(agentId: string): Promise<boolean>;
}

export class UsageError extends Error {}

export type AcquireResult =
  | { status: "held"; lease: Lease; renewed: boolean; tookOverFrom: string | null }
  | { status: "queued"; lease: Lease; position: number };

const DEFAULT_SETTINGS = (): Pick<LeasesSettings, "maxTtlSeconds"> => ({ maxTtlSeconds: 7 * 24 * 3600 });

/**
 * Named leases with a fencing token (`handover`), a waiting queue and takeover.
 * Every operation first settles expired holders, so correctness never depends on the tick.
 */
export class Engine {
  private busy = false;
  private readonly permissions = new Set<string>();

  constructor(
    readonly store: Store,
    private readonly actions: Actions,
    private readonly settings: () => LeasesSettings | null,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- agents ----

  acquire(agentId: string, name: string, ttlSeconds: number, mode: LeaseMode): AcquireResult {
    const now = this.now();
    const max = (this.settings() ?? DEFAULT_SETTINGS()).maxTtlSeconds;
    if (!(ttlSeconds > 0)) throw new UsageError("ttl must be a positive number of seconds.");
    if (ttlSeconds > max) throw new UsageError(`ttl is capped at ${max} seconds.`);
    const lease = this.store.ensureLease(name, now);
    this.settle(lease, now);

    // Asking again for a lease you hold renews it and keeps the token.
    if (lease.holder?.agentId === agentId) {
      lease.holder.ttlSeconds = ttlSeconds;
      lease.holder.expiresAt = now + ttlSeconds * 1000;
      this.touch(lease, now, { type: "renewed", actor: agentId, detail: "acquire by holder" });
      return { status: "held", lease, renewed: true, tookOverFrom: null };
    }

    if (!lease.holder) {
      this.dequeue(lease, agentId);
      this.grant(lease, agentId, ttlSeconds, mode, now);
      this.touch(lease, now, { type: "acquired", actor: agentId, detail: `${mode}, ${ttlSeconds}s` });
      return { status: "held", lease, renewed: false, tookOverFrom: null };
    }

    if (mode === "takeover") {
      const previous = lease.holder.agentId;
      this.dequeue(lease, agentId);
      this.notify(previous, lease, "lost", `taken over by ${this.label(agentId)}`, lease.handover);
      this.grant(lease, agentId, ttlSeconds, mode, now);
      this.touch(lease, now, { type: "taken_over", actor: agentId, detail: `from ${previous}` });
      return { status: "held", lease, renewed: false, tookOverFrom: previous };
    }

    const queued = lease.queue.find((w) => w.agentId === agentId);
    if (queued) queued.ttlSeconds = ttlSeconds;
    else lease.queue.push({ agentId, ttlSeconds, enqueuedAt: now });
    this.touch(lease, now, queued ? null : { type: "queued", actor: agentId, detail: `behind ${lease.holder.agentId}` });
    return { status: "queued", lease, position: lease.queue.findIndex((w) => w.agentId === agentId) + 1 };
  }

  renew(agentId: string, name: string, token: number, ttlSeconds?: number): Lease {
    const now = this.now();
    const lease = this.store.lease(name);
    if (!lease) throw this.refuse(name, agentId, "renew", `No lease "${name}" exists.`);
    this.settle(lease, now);
    const holder = this.checkHolder(lease, agentId, token, "renew");
    const max = (this.settings() ?? DEFAULT_SETTINGS()).maxTtlSeconds;
    const ttl = ttlSeconds ?? holder.ttlSeconds;
    if (!(ttl > 0) || ttl > max) throw new UsageError(`ttl must be between 1 and ${max} seconds.`);
    holder.ttlSeconds = ttl;
    holder.expiresAt = now + ttl * 1000;
    this.touch(lease, now, { type: "renewed", actor: agentId, detail: `${ttl}s` });
    return lease;
  }

  /** With a token: the holder gives the lease up. Without: a waiting agent leaves the queue. */
  release(agentId: string, name: string, token?: number): { released: boolean; promoted: string | null } {
    const now = this.now();
    const lease = this.store.lease(name);
    if (!lease) throw this.refuse(name, agentId, "release", `No lease "${name}" exists.`);
    this.settle(lease, now);
    if (token === undefined) {
      if (lease.holder?.agentId === agentId) throw this.refuse(name, agentId, "release", `You hold "${name}": pass your token to release it.`);
      if (!this.dequeue(lease, agentId)) throw this.refuse(name, agentId, "release", `You are neither holding nor waiting for "${name}".`);
      this.touch(lease, now, { type: "dequeued", actor: agentId, detail: null });
      return { released: false, promoted: null };
    }
    this.checkHolder(lease, agentId, token, "release");
    lease.holder = null;
    this.touch(lease, now, { type: "released", actor: agentId, detail: null });
    return { released: true, promoted: this.promote(lease, now) };
  }

  // ---- human ----

  forceRelease(name: string): { ok: boolean; message: string | null } {
    const now = this.now();
    const lease = this.store.lease(name);
    if (!lease) return { ok: false, message: "No such lease." };
    this.settle(lease, now);
    if (!lease.holder) return { ok: false, message: "The lease is not held." };
    const previous = lease.holder.agentId;
    this.notify(previous, lease, "lost", "released by a human", lease.handover);
    lease.holder = null;
    this.touch(lease, now, { type: "force_released", actor: "human", detail: `holder ${previous}` });
    this.promote(lease, now);
    return { ok: true, message: null };
  }

  // ---- agent lifecycle ----

  /** An archived agent frees every lease it holds and leaves every queue. */
  agentArchived(agentId: string): void {
    const now = this.now();
    for (const lease of this.store.leases()) {
      const waiting = this.dequeue(lease, agentId);
      if (lease.holder?.agentId === agentId) {
        lease.holder = null;
        this.touch(lease, now, { type: "archived", actor: "system", detail: `holder ${agentId} archived` });
        this.promote(lease, now);
      } else if (waiting) {
        this.touch(lease, now, { type: "archived", actor: "system", detail: `waiter ${agentId} archived` });
      }
    }
    for (const m of this.store.outbox()) {
      if (m.agentId === agentId && m.status === "pending") m.status = "undeliverable";
    }
    this.store.save();
  }

  permission(agentId: string, pending: boolean): void {
    if (pending) this.permissions.add(agentId);
    else this.permissions.delete(agentId);
  }

  // ---- internals ----

  private label(agentId: string): string {
    const title = this.store.agent(agentId)?.title;
    return title ? `${title} (${agentId})` : agentId;
  }

  private refuse(name: string, agentId: string, op: string, message: string): UsageError {
    this.store.log({ lease: name, type: "refused", actor: agentId, detail: `${op}: ${message}` }, this.now());
    this.store.save();
    return new UsageError(`Refused: ${message}`);
  }

  private checkHolder(lease: Lease, agentId: string, token: number, op: string) {
    const holder = lease.holder;
    if (!holder) throw this.refuse(lease.name, agentId, op, `"${lease.name}" is not held (it expired or was released). You no longer have it; acquire it again.`);
    if (token !== lease.handover || holder.agentId !== agentId) {
      throw this.refuse(lease.name, agentId, op, `token ${token} is stale for "${lease.name}" (current handover is ${lease.handover}${holder.agentId === agentId ? "" : ", held by another agent"}). You lost this lease: stop working on the resource.`);
    }
    return holder;
  }

  private grant(lease: Lease, agentId: string, ttlSeconds: number, mode: LeaseMode, now: number): void {
    lease.handover += 1;
    lease.holder = { agentId, mode, ttlSeconds, acquiredAt: now, expiresAt: now + ttlSeconds * 1000 };
  }

  private dequeue(lease: Lease, agentId: string): boolean {
    const before = lease.queue.length;
    lease.queue = lease.queue.filter((w) => w.agentId !== agentId);
    return lease.queue.length !== before;
  }

  private touch(lease: Lease, now: number, event: { type: Parameters<Store["log"]>[0]["type"]; actor: string; detail: string | null } | null): void {
    lease.updatedAt = now;
    if (event) this.store.log({ lease: lease.name, ...event }, now);
    this.store.save();
  }

  /** Expire an overdue holder and hand the lease to the next waiter. Returns true if anything changed. */
  private settle(lease: Lease, now: number): boolean {
    if (!lease.holder || lease.holder.expiresAt > now) return false;
    const previous = lease.holder.agentId;
    this.notify(previous, lease, "lost", "it expired because it was not renewed in time", lease.handover);
    lease.holder = null;
    this.touch(lease, now, { type: "expired", actor: "system", detail: `holder ${previous}` });
    this.promote(lease, now);
    return true;
  }

  /** Give a free lease to the next waiter and wake them. Returns the new holder, if any. */
  private promote(lease: Lease, now: number): string | null {
    if (lease.holder) return null;
    const next = lease.queue.shift();
    if (!next) return null;
    this.grant(lease, next.agentId, next.ttlSeconds, "queue", now);
    this.notify(next.agentId, lease, "granted", "", lease.handover);
    this.touch(lease, now, { type: "granted", actor: "system", detail: `to ${next.agentId}` });
    return next.agentId;
  }

  private notify(agentId: string, lease: Lease, kind: "granted" | "lost", reason: string, token: number): void {
    const s = this.settings();
    const vars = { name: lease.name, token, reason, ttl: lease.holder?.ttlSeconds ?? 0 };
    // The message is recorded now and sent by deliver(), so a failure or restart cannot lose it.
    this.store.enqueue({ agentId, lease: lease.name, kind, text: render((kind === "granted" ? s?.grantedTemplate : s?.lostTemplate) ?? "", vars) }, this.now());
  }

  // ---- background ----

  /** Settle overdue holders, deliver owed messages, notice archived agents. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const lease of this.store.leases()) this.settle(lease, now);
      await this.deliver();
      await this.sweepArchived();
      this.store.prune(now, this.settings()?.retentionDays ?? 30);
      this.store.save();
    } finally {
      this.busy = false;
    }
  }

  /** Backstop for a missed agent.archived event: ask about holders and waiters, a few per tick. */
  private async sweepArchived(): Promise<void> {
    const ids = new Set<string>();
    for (const l of this.store.leases()) {
      if (l.holder) ids.add(l.holder.agentId);
      for (const w of l.queue) ids.add(w.agentId);
    }
    for (const agentId of [...ids].slice(0, 5)) {
      let archived = false;
      try {
        archived = await this.actions.isArchived(agentId);
      } catch {
        continue;
      }
      if (archived) this.agentArchived(agentId);
    }
  }

  /** Send owed messages, oldest first, never to an agent with a pending permission request. */
  async deliver(): Promise<void> {
    const s = this.settings();
    if (!s) return;
    for (const m of this.store.outbox().filter((o) => o.status === "pending").sort((a, b) => a.createdAt - b.createdAt)) {
      const now = this.now();
      if (this.permissions.has(m.agentId)) continue;
      // Retry spacing grows with attempts, so a broken agent is not hammered.
      if (m.lastAttemptAt !== null && now - m.lastAttemptAt < Math.min(2 ** m.attempts * 5_000, 15 * 60_000)) continue;
      m.attempts += 1;
      m.lastAttemptAt = now;
      try {
        await this.actions.send(m.agentId, m.text);
        m.status = "sent";
        this.store.log({ lease: m.lease, type: "delivered", actor: "system", detail: `${m.kind} to ${m.agentId}` }, now);
      } catch (error) {
        const detail = (error as Error).message;
        if (await this.actions.isArchived(m.agentId).catch(() => false)) {
          m.status = "undeliverable";
          this.store.log({ lease: m.lease, type: "undeliverable", actor: "system", detail: `${m.agentId} archived or gone` }, now);
        } else {
          if (m.attempts >= s.maxDeliveryAttempts) m.status = "failed";
          this.store.log({ lease: m.lease, type: "delivery_failed", actor: "system", detail }, now);
        }
      }
      this.store.save();
    }
  }

  // ---- views ----

  /** Settles first so a list never shows a holder whose lease already ran out. */
  views(): LeaseView[] {
    const now = this.now();
    for (const l of this.store.leases()) this.settle(l, now);
    return this.store
      .leases()
      .filter((l) => l.holder || l.queue.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({
        name: l.name,
        handover: l.handover,
        holder: l.holder ? { ...l.holder, agentTitle: this.store.agent(l.holder.agentId)?.title ?? null } : null,
        queue: l.queue.map((w) => ({ ...w, agentTitle: this.store.agent(w.agentId)?.title ?? null })),
      }));
  }

  count(): { held: number; waiting: number } {
    const views = this.views();
    return { held: views.filter((v) => v.holder).length, waiting: views.reduce((n, v) => n + v.queue.length, 0) };
  }
}
