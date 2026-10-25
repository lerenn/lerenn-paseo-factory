import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { settingsSchema } from "../shared/settings";
import { Engine, UsageError, type Actions } from "./engine";
import { Store } from "./store";

function setup(opts: { sendFails?: () => boolean; archived?: Set<string>; store?: Store } = {}) {
  let t = 1_000_000;
  const sent: { agentId: string; text: string }[] = [];
  const actions: Actions = {
    async send(agentId, text) {
      if (opts.sendFails?.()) throw new Error("down");
      sent.push({ agentId, text });
    },
    async isArchived(id) {
      return opts.archived?.has(id) ?? false;
    },
  };
  const store = opts.store ?? new Store(null);
  const engine = new Engine(store, actions, () => settingsSchema.parse({}), () => t);
  return { store, engine, sent, advance: (ms: number) => (t += ms) };
}

describe("acquire", () => {
  it("grants a free lease with token 1 and renews on a repeated acquire", () => {
    const { engine } = setup();
    const r = engine.acquire("a", "qa", 60, "queue");
    expect(r.status).toBe("held");
    expect(r.lease.handover).toBe(1);
    const again = engine.acquire("a", "qa", 120, "queue");
    expect(again).toMatchObject({ status: "held", renewed: true });
    expect(again.lease.handover).toBe(1);
    expect(again.lease.holder?.ttlSeconds).toBe(120);
  });

  it("validates the ttl", () => {
    const { engine } = setup();
    expect(() => engine.acquire("a", "qa", 0, "queue")).toThrow(UsageError);
    expect(() => engine.acquire("a", "qa", 10 * 24 * 3600, "queue")).toThrow(UsageError);
  });
});

describe("queue mode", () => {
  it("queues behind the holder and hands over, with a wake-up, on release", async () => {
    const { engine, sent } = setup();
    const a = engine.acquire("a", "qa", 60, "queue");
    const b = engine.acquire("b", "qa", 30, "queue");
    expect(b).toMatchObject({ status: "queued", position: 1 });
    expect(engine.acquire("c", "qa", 30, "queue")).toMatchObject({ status: "queued", position: 2 });
    // queuing twice does not duplicate
    expect(engine.acquire("b", "qa", 45, "queue")).toMatchObject({ status: "queued", position: 1 });

    const r = engine.release("a", "qa", a.lease.handover);
    expect(r).toEqual({ released: true, promoted: "b" });
    const lease = engine.store.lease("qa")!;
    expect(lease.handover).toBe(2);
    expect(lease.holder).toMatchObject({ agentId: "b", ttlSeconds: 45 });
    await engine.deliver();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("b");
    expect(sent[0]!.text).toContain("token 2");
    expect(lease.queue.map((w) => w.agentId)).toEqual(["c"]);
  });

  it("hands over when the holder lets the lease expire, and tells the old holder", async () => {
    const { engine, sent, advance } = setup();
    engine.acquire("a", "qa", 60, "queue");
    engine.acquire("b", "qa", 60, "queue");
    advance(61_000);
    await engine.tick();
    expect(engine.store.lease("qa")!.holder?.agentId).toBe("b");
    expect(sent.map((m) => m.agentId).sort()).toEqual(["a", "b"]);
    expect(sent.find((m) => m.agentId === "a")!.text).toContain("expired");
  });

  it("frees the lease at expiry when nobody waits, and refuses the stale holder", () => {
    const { engine, advance } = setup();
    const a = engine.acquire("a", "qa", 60, "queue");
    advance(61_000);
    expect(() => engine.renew("a", "qa", a.lease.handover)).toThrow(/not held/);
    expect(engine.views()).toEqual([]);
    // the counter keeps climbing across a free period
    expect(engine.acquire("a", "qa", 60, "queue").lease.handover).toBe(2);
  });

  it("lets a waiter leave the queue", () => {
    const { engine } = setup();
    engine.acquire("a", "qa", 60, "queue");
    engine.acquire("b", "qa", 60, "queue");
    expect(engine.release("b", "qa")).toEqual({ released: false, promoted: null });
    expect(engine.store.lease("qa")!.queue).toEqual([]);
    expect(() => engine.release("b", "qa")).toThrow(UsageError);
    expect(() => engine.release("a", "qa")).toThrow(/pass your token/);
  });
});

describe("takeover mode", () => {
  it("takes the lease at once and tells the previous holder it lost it", async () => {
    const { engine, sent } = setup();
    const a = engine.acquire("a", "qa:T-1", 60, "takeover");
    const b = engine.acquire("b", "qa:T-1", 60, "takeover");
    expect(b).toMatchObject({ status: "held", tookOverFrom: "a" });
    expect(b.lease.handover).toBe(2);
    await engine.deliver();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "a" });
    expect(sent[0]!.text).toContain("lost lease");
    expect(sent[0]!.text).toContain("token 1");
    // the old holder is refused on both renew and release
    expect(() => engine.renew("a", "qa:T-1", a.lease.handover)).toThrow(/stale/);
    expect(() => engine.release("a", "qa:T-1", a.lease.handover)).toThrow(/stale/);
    expect(engine.store.lease("qa:T-1")!.holder?.agentId).toBe("b");
  });

  it("keeps waiters queued and removes a queued agent that takes over", () => {
    const { engine } = setup();
    engine.acquire("a", "x", 60, "queue");
    engine.acquire("b", "x", 60, "queue");
    engine.acquire("c", "x", 60, "queue");
    engine.acquire("b", "x", 60, "takeover");
    const l = engine.store.lease("x")!;
    expect(l.holder?.agentId).toBe("b");
    expect(l.queue.map((w) => w.agentId)).toEqual(["c"]);
  });
});

describe("fencing", () => {
  it("refuses a wrong token, even from the holder, and records the refusal", () => {
    const { engine } = setup();
    const a = engine.acquire("a", "qa", 60, "queue");
    expect(() => engine.renew("a", "qa", a.lease.handover + 5)).toThrow(/stale/);
    expect(() => engine.renew("b", "qa", a.lease.handover)).toThrow(/stale/);
    expect(() => engine.renew("a", "nope", 1)).toThrow(/No lease/);
    expect(engine.store.events().filter((e) => e.type === "refused")).toHaveLength(3);
    expect(engine.renew("a", "qa", a.lease.handover, 90).holder?.ttlSeconds).toBe(90);
  });

  it("renew extends the expiry so the lease survives", () => {
    const { engine, advance } = setup();
    const a = engine.acquire("a", "qa", 60, "queue");
    advance(50_000);
    engine.renew("a", "qa", a.lease.handover);
    advance(50_000);
    expect(engine.views()[0]!.holder?.agentId).toBe("a");
  });
});

describe("archive and force release", () => {
  it("releases leases of an archived holder and removes it from queues", async () => {
    const { engine, sent } = setup();
    engine.acquire("a", "x", 60, "queue");
    engine.acquire("b", "x", 60, "queue");
    engine.acquire("a", "y", 60, "queue");
    engine.acquire("c", "y", 60, "queue");
    engine.acquire("c", "z", 60, "queue");
    engine.acquire("a", "z", 60, "queue");
    engine.agentArchived("a");
    expect(engine.store.lease("x")!.holder?.agentId).toBe("b");
    expect(engine.store.lease("y")!.holder?.agentId).toBe("c");
    expect(engine.store.lease("z")!.queue).toEqual([]);
    await engine.deliver();
    expect(sent.map((m) => m.agentId).sort()).toEqual(["b", "c"]);
  });

  it("notices an archived holder on tick even if the event was missed", async () => {
    const archived = new Set<string>();
    const { engine } = setup({ archived });
    engine.acquire("a", "x", 60, "queue");
    engine.acquire("b", "x", 60, "queue");
    archived.add("a");
    await engine.tick();
    expect(engine.store.lease("x")!.holder?.agentId).toBe("b");
  });

  it("force release frees the lease, tells the holder and wakes the next waiter", async () => {
    const { engine, sent } = setup();
    engine.acquire("a", "x", 60, "queue");
    engine.acquire("b", "x", 60, "queue");
    expect(engine.forceRelease("x")).toEqual({ ok: true, message: null });
    expect(engine.store.lease("x")!.holder?.agentId).toBe("b");
    await engine.deliver();
    expect(sent.find((m) => m.agentId === "a")!.text).toContain("released by a human");
    expect(engine.forceRelease("nope").ok).toBe(false);
    engine.release("b", "x", 2);
    expect(engine.forceRelease("x").ok).toBe(false);
  });
});

describe("delivery and durability", () => {
  it("retries a failed wake-up with backoff and gives up after the max attempts", async () => {
    let down = true;
    const { engine, sent, advance } = setup({ sendFails: () => down });
    engine.acquire("a", "x", 60, "queue");
    engine.acquire("b", "x", 60, "queue");
    engine.release("a", "x", 1);
    await engine.deliver();
    expect(sent).toHaveLength(0);
    await engine.deliver(); // too soon: backoff
    expect(engine.store.outbox()[0]!.attempts).toBe(1);
    down = false;
    advance(11_000);
    await engine.deliver();
    expect(sent).toHaveLength(1);
    expect(engine.store.outbox()[0]!.status).toBe("sent");
  });

  it("marks messages to an archived agent undeliverable", async () => {
    const { engine } = setup({ sendFails: () => true, archived: new Set(["b"]) });
    engine.acquire("a", "x", 60, "queue");
    engine.acquire("b", "x", 60, "queue");
    engine.release("a", "x", 1);
    await engine.deliver();
    expect(engine.store.outbox()[0]!.status).toBe("undeliverable");
  });

  it("survives a restart: leases, fencing counter, queue and owed messages", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "leases-")), "state.json");
    const first = setup({ store: new Store(file), sendFails: () => true });
    first.engine.acquire("a", "x", 600, "queue");
    first.engine.acquire("b", "x", 600, "queue");
    first.engine.release("a", "x", 1);
    first.engine.acquire("c", "x", 600, "queue");

    const second = setup({ store: new Store(file) });
    const lease = second.store.lease("x")!;
    expect(lease.handover).toBe(2);
    expect(lease.holder?.agentId).toBe("b");
    expect(lease.queue.map((w) => w.agentId)).toEqual(["c"]);
    expect(() => second.engine.renew("a", "x", 1)).toThrow(/stale/);
    await second.engine.deliver();
    expect(second.sent.map((m) => m.agentId)).toEqual(["b"]);
  });
});

describe("views", () => {
  it("lists only active leases, sorted, with agent titles", () => {
    const { engine, store } = setup();
    store.upsertAgent("a", { title: "QA agent" });
    engine.acquire("a", "b-lease", 60, "queue");
    engine.acquire("a", "a-lease", 60, "queue");
    engine.acquire("z", "a-lease", 60, "queue");
    engine.acquire("a", "free", 60, "queue");
    engine.release("a", "free", 1);
    const v = engine.views();
    expect(v.map((l) => l.name)).toEqual(["a-lease", "b-lease"]);
    expect(v[0]!.holder?.agentTitle).toBe("QA agent");
    expect(v[0]!.queue).toHaveLength(1);
    expect(engine.count()).toEqual({ held: 2, waiting: 1 });
  });
});
