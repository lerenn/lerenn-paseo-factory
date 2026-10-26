import { APPROVAL_OPTIONS, type InboxOption, type ItemView } from "../../shared/inbox/item";
import type { InboxSettings } from "../../shared/inbox/settings";
import { render } from "./template";
import type { Item, Store } from "./store";

/** What the engine does to the outside world; the plugin wires it to the Paseo SDK. */
export interface Actions {
  send(agentId: string, text: string): Promise<void>;
  /** True when the agent was archived (or no longer exists). */
  isArchived(agentId: string): Promise<boolean>;
}

export class UsageError extends Error {}

export interface AskInput {
  agentId: string;
  question: string;
  kind?: "question" | "approval";
  options?: InboxOption[];
  allowFreeText?: boolean;
  context?: string;
  blocking?: boolean;
  expiresInMinutes?: number;
  defaultAnswer?: string;
  dedupeKey?: string;
  /** Asked by the Factory for a blueprint gate or escalation: nobody is messaged when it is answered. */
  internal?: boolean;
}

export type Resolution = "answered" | "expired";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Stable key for "the same question": asking it again while pending returns the live item. */
export function fingerprint(kind: string, question: string, options: InboxOption[]): string {
  return JSON.stringify([kind, question.trim().replace(/\s+/g, " "), options.map((o) => o.id)]);
}

export class Engine {
  private lastSendAt = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<(item: Item, how: Resolution) => void>();
  private busy = false;
  private readonly permissions = new Set<string>();

  constructor(
    readonly store: Store,
    private readonly actions: Actions,
    private readonly settings: () => InboxSettings | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Told when an item is answered or expires; used by the Factory's blueprint gates. */
  onResolved(listener: (item: Item, how: Resolution) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private resolved(item: Item, how: Resolution): void {
    if (item.internal) {
      item.owed = null;
      item.delivery = "none";
    }
    for (const l of this.listeners) {
      try {
        l(item, how);
      } catch (error) {
        console.error("inbox: listener failed", error);
      }
    }
  }

  // ---- asking ----

  ask(input: AskInput): { item: Item; deduped: boolean } {
    const kind = input.kind ?? "question";
    const given = input.options?.length ? input.options : kind === "approval" ? APPROVAL_OPTIONS : [];
    // The recommended choice goes first (stable otherwise).
    const options = [...given.filter((o) => o.recommended), ...given.filter((o) => !o.recommended)];
    const ids = new Set(options.map((o) => o.id));
    if (ids.size !== options.length) throw new UsageError("Option ids must be unique.");
    // Every item ends with an open "Other" answer, whatever the options.
    const allowFreeText = true;

    const expiry = input.expiresInMinutes ?? (this.settings()?.defaultExpiryMinutes || undefined);
    if (input.defaultAnswer !== undefined && !expiry) throw new UsageError("default_answer needs expires_in_minutes.");
    let defaultOptionId: string | null = null;
    let defaultText: string | null = null;
    if (input.defaultAnswer !== undefined) {
      if (ids.has(input.defaultAnswer)) defaultOptionId = input.defaultAnswer;
      else if (allowFreeText) defaultText = input.defaultAnswer;
      else throw new UsageError(`default_answer must be one of the option ids: ${[...ids].join(", ")}.`);
    }

    const key = input.dedupeKey ?? fingerprint(kind, input.question, options);
    const live = this.store.live(input.agentId, key);
    if (live) {
      this.store.log({ itemId: live.id, type: "deduped", actor: input.agentId, detail: null }, this.now());
      this.store.save();
      return { item: live, deduped: true };
    }
    const now = this.now();
    const item = this.store.add(
      {
        agentId: input.agentId,
        kind,
        question: clip(input.question.trim(), 4000),
        context: input.context ? clip(input.context, 20_000) : null,
        options,
        allowFreeText,
        blocking: input.blocking ?? true,
        dedupeKey: key,
        expiresAt: expiry ? now + expiry * 60_000 : null,
        defaultOptionId,
        defaultText,
        internal: input.internal ?? false,
      },
      now,
    );
    this.store.log({ itemId: item.id, type: "asked", actor: input.agentId, detail: item.kind }, now);
    this.store.save();
    return { item, deduped: false };
  }

  // ---- answering (human) ----

  /** Records the answer once. A second answer is refused and changes nothing. */
  answer(itemId: string, input: { optionId?: string; text?: string; comment?: string }, by: "human" | "assistant" = "human"): { ok: boolean; message: string | null; item: Item | null } {
    const item = this.store.get(itemId);
    const now = this.now();
    if (!item) return { ok: false, message: "No such item.", item: null };
    const refuse = (message: string) => {
      this.store.log({ itemId, type: "answer_refused", actor: "human", detail: message }, now);
      this.store.save();
      return { ok: false, message, item };
    };
    if (item.status !== "pending") return refuse(`Already ${item.status}${item.answer ? ` (answered ${item.answer.optionId ?? "with text"})` : ""}; the first answer stands.`);
    const text = input.text?.trim() || null;
    if (input.optionId) {
      if (!item.options.some((o) => o.id === input.optionId)) return refuse(`Unknown option "${input.optionId}".`);
    } else if (text) {
      if (!item.allowFreeText) return refuse("This item takes one of its options, not free text.");
    } else return refuse("Pick an option or write an answer.");

    item.status = "answered";
    item.answer = { optionId: input.optionId ?? null, text: input.optionId ? null : text, by, at: now };
    item.comment = input.comment?.trim() || (input.optionId ? text : null);
    item.owed = "answer";
    item.delivery = "pending";
    item.readAt ??= now;
    item.endedAt = now;
    this.store.log({ itemId, type: "answered", actor: by === "assistant" ? "assistant on behalf of the user" : "human", detail: item.answer.optionId ?? clip(text ?? "", 200) }, now);
    this.store.save();
    this.resolved(item, "answered");
    return { ok: true, message: null, item };
  }

  markRead(itemId: string): void {
    const item = this.store.get(itemId);
    if (!item || item.readAt !== null) return;
    item.readAt = this.now();
    this.store.log({ itemId, type: "read", actor: "human", detail: null }, item.readAt);
    this.store.save();
  }

  /** The asker takes its own pending question back. */
  withdraw(item: Item, actor: string, reason: string | null): void {
    if (item.status !== "pending") throw new UsageError(`Item ${item.id} is already ${item.status}.`);
    this.close(item, "withdrawn", actor, reason);
  }

  agentArchived(agentId: string): void {
    for (const item of this.store.pending(agentId)) this.close(item, "archived", "system", "asking agent archived");
  }

  permission(agentId: string, pending: boolean): void {
    if (pending) this.permissions.add(agentId);
    else this.permissions.delete(agentId);
  }

  private close(item: Item, status: "withdrawn" | "archived" | "expired", actor: string, detail: string | null): void {
    const now = this.now();
    item.status = status;
    item.endedAt = now;
    this.store.log({ itemId: item.id, type: status, actor, detail }, now);
    this.store.save();
  }

  // ---- background ----

  /** Expire overdue items, deliver owed messages, notice archived askers. Never throws per item. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const item of this.store.pending()) {
        if (item.expiresAt === null || item.expiresAt > now) continue;
        if (item.defaultOptionId || item.defaultText) {
          item.status = "answered";
          item.answer = { optionId: item.defaultOptionId, text: item.defaultText, by: "default", at: now };
          item.owed = "answer";
          item.delivery = "pending";
          item.endedAt = now;
          this.store.log({ itemId: item.id, type: "expired", actor: "system", detail: `default: ${item.defaultOptionId ?? item.defaultText}` }, now);
          this.resolved(item, "answered");
        } else {
          item.status = "expired";
          item.owed = "expired";
          item.delivery = "pending";
          item.endedAt = now;
          this.store.log({ itemId: item.id, type: "expired", actor: "system", detail: null }, now);
          this.resolved(item, "expired");
        }
        this.store.save();
      }
      await this.deliver();
      await this.sweepArchived();
      this.store.prune(now, this.settings()?.retentionDays ?? 30);
    } finally {
      this.busy = false;
    }
  }

  /** Backstop for a missed agent.archived event: ask about askers of pending items, a few per tick. */
  private async sweepArchived(): Promise<void> {
    const agents = [...new Set(this.store.pending().filter((i) => !i.internal).map((i) => i.agentId))].slice(0, 5);
    for (const agentId of agents) {
      let archived = false;
      try {
        archived = await this.actions.isArchived(agentId);
      } catch {
        continue;
      }
      if (archived) this.agentArchived(agentId);
    }
  }

  private message(item: Item): string {
    const s = this.settings();
    const fallback = { question: clip(item.question, 120), id: item.id };
    if (item.owed === "expired") return render(s?.expiredTemplate ?? "", fallback);
    const a = item.answer!;
    const label = a.optionId ? (item.options.find((o) => o.id === a.optionId)?.label ?? a.optionId) : (a.text ?? "");
    const answer = a.optionId ? `${a.optionId}${label !== a.optionId ? ` (${label})` : ""}` : `"${a.text}"`;
    return render(s?.answerTemplate ?? "", {
      ...fallback,
      by: a.by === "default" ? " by default after expiry" : a.by === "assistant" ? " by the Assistant on behalf of the user" : "",
      answer,
      comment: item.comment ? `. Comment: ${item.comment}` : "",
    });
  }

  /** Send owed messages: one per global gap, never to an agent with a pending permission request. */
  async deliver(): Promise<void> {
    const s = this.settings();
    if (!s) return;
    const owed = this.store.all().filter((i) => i.delivery === "pending").sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const item of owed) {
      const now = this.now();
      if (now - this.lastSendAt < s.globalGapSeconds * 1000) return;
      if (this.permissions.has(item.agentId)) continue;
      // Retry spacing grows with attempts, so a broken agent is not hammered.
      if (item.lastAttemptAt !== null && now - item.lastAttemptAt < Math.min(2 ** item.deliveryAttempts * 5_000, 15 * 60_000)) continue;
      item.deliveryAttempts += 1;
      item.lastAttemptAt = now;
      this.lastSendAt = now;
      try {
        await this.actions.send(item.agentId, this.message(item));
        item.delivery = "sent";
        this.store.log({ itemId: item.id, type: "delivered", actor: "system", detail: null }, now);
      } catch (error) {
        const detail = (error as Error).message;
        // An archived or vanished asker can never be told: mark it so the UI says so, instead of retrying.
        if (await this.actions.isArchived(item.agentId).catch(() => false)) {
          item.delivery = "undeliverable";
          this.store.log({ itemId: item.id, type: "undeliverable", actor: "system", detail: "asking agent archived or gone" }, now);
          this.store.save();
          continue;
        }
        if (item.deliveryAttempts >= s.maxDeliveryAttempts) item.delivery = "failed";
        this.store.log({ itemId: item.id, type: "delivery_failed", actor: "system", detail }, now);
      }
      this.store.save();
    }
  }

  // ---- views ----

  count(): { unread: number; pending: number } {
    const pending = this.store.pending();
    return { pending: pending.length, unread: pending.filter((i) => i.readAt === null).length };
  }

  views(): ItemView[] {
    return this.store.all().map((i) => {
      const a = this.store.agent(i.agentId);
      return {
        id: i.id,
        agentId: i.agentId,
        agentTitle: a?.title ?? null,
        projectName: a?.projectName ?? null,
        workspaceName: a?.workspaceName ?? null,
        kind: i.kind,
        question: i.question,
        context: i.context,
        options: i.options,
        allowFreeText: i.allowFreeText,
        blocking: i.blocking,
        status: i.status,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        defaultOptionId: i.defaultOptionId,
        defaultText: i.defaultText,
        readAt: i.readAt,
        answer: i.answer,
        comment: i.comment,
        delivery: i.delivery,
        endedAt: i.endedAt,
      };
    });
  }

  view(item: Item): ItemView {
    return this.views().find((v) => v.id === item.id)!;
  }
}
