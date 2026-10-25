import { describe, expect, it } from "vitest";
import { settingsSchema } from "../shared/settings";
import { Engine, UsageError, type Actions } from "./engine";
import { Store } from "./store";

function setup(opts: { sendFails?: () => boolean; archived?: Set<string> } = {}) {
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
  const store = new Store(null);
  const engine = new Engine(store, actions, () => settingsSchema.parse({ globalGapSeconds: 0 }), () => t);
  return { store, engine, sent, advance: (ms: number) => (t += ms) };
}

describe("ask", () => {
  it("is idempotent while pending, and asks again once answered", () => {
    const { engine } = setup();
    const a = engine.ask({ agentId: "a1", question: "Ship it?", kind: "approval" });
    const b = engine.ask({ agentId: "a1", question: "Ship  it?", kind: "approval" });
    expect(b.deduped).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    expect(a.item.options.map((o) => o.id)).toEqual(["approve", "deny"]);
    engine.answer(a.item.id, { optionId: "approve" });
    expect(engine.ask({ agentId: "a1", question: "Ship it?", kind: "approval" }).deduped).toBe(false);
    expect(engine.ask({ agentId: "a2", question: "Ship it?", kind: "approval" }).deduped).toBe(false);
  });

  it("validates defaults", () => {
    const { engine } = setup();
    expect(() => engine.ask({ agentId: "a", question: "q", defaultAnswer: "x" })).toThrow(UsageError);
    expect(() => engine.ask({ agentId: "a", question: "q", options: [{ id: "y", label: "Y" }], expiresInMinutes: 5, defaultAnswer: "n" })).toThrow(UsageError);
    expect(() => engine.ask({ agentId: "a", question: "q", options: [{ id: "y", label: "Y" }, { id: "y", label: "Z" }] })).toThrow(UsageError);
  });
});

describe("answer", () => {
  it("records once and refuses a second answer", () => {
    const { engine, store } = setup();
    const { item } = engine.ask({ agentId: "a", question: "Pick", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] });
    expect(engine.answer(item.id, { optionId: "x" }).ok).toBe(true);
    const second = engine.answer(item.id, { optionId: "y" });
    expect(second.ok).toBe(false);
    expect(item.answer?.optionId).toBe("x");
    expect(store.events().map((e) => e.type)).toEqual(["asked", "answered", "answer_refused"]);
  });

  it("checks options and free text", () => {
    const { engine } = setup();
    const { item } = engine.ask({ agentId: "a", question: "Pick", options: [{ id: "x", label: "X" }] });
    expect(engine.answer(item.id, { optionId: "nope" }).ok).toBe(false);
    expect(engine.answer(item.id, { text: "hmm" }).ok).toBe(false);
    expect(engine.answer(item.id, {}).ok).toBe(false);
    const free = engine.ask({ agentId: "a", question: "Why?" }).item;
    expect(engine.answer(free.id, { text: " because " }).item?.answer?.text).toBe("because");
  });
});

describe("delivery", () => {
  it("wakes the asker with the answer and records it as sent", async () => {
    const { engine, sent } = setup();
    const { item } = engine.ask({ agentId: "a", question: "Ship it?", kind: "approval" });
    engine.answer(item.id, { optionId: "approve", comment: "go" });
    await engine.deliver();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Agents Inbox:");
    expect(sent[0].text).toContain("approve (Approve)");
    expect(sent[0].text).toContain("Comment: go");
    expect(item.delivery).toBe("sent");
    await engine.deliver();
    expect(sent).toHaveLength(1);
  });

  it("keeps the answer and retries when the send fails", async () => {
    let fail = true;
    const { engine, sent, advance } = setup({ sendFails: () => fail });
    const { item } = engine.ask({ agentId: "a", question: "q" });
    engine.answer(item.id, { text: "hi" });
    await engine.deliver();
    expect(item.delivery).toBe("pending");
    expect(item.answer?.text).toBe("hi");
    fail = false;
    await engine.deliver();
    expect(sent).toHaveLength(0); // backoff
    advance(60_000);
    await engine.deliver();
    expect(sent).toHaveLength(1);
  });

  it("gives up after the attempt cap but keeps the answer", async () => {
    const { engine, advance } = setup({ sendFails: () => true });
    const { item } = engine.ask({ agentId: "a", question: "q" });
    engine.answer(item.id, { text: "hi" });
    for (let i = 0; i < 10; i++) {
      await engine.deliver();
      advance(20 * 60_000);
    }
    expect(item.delivery).toBe("failed");
    expect(item.status).toBe("answered");
  });

  it("marks an answer undeliverable when the asker is archived or gone", async () => {
    const archived = new Set<string>();
    const { engine, sent } = setup({ sendFails: () => true, archived });
    const { item } = engine.ask({ agentId: "a", question: "q" });
    engine.answer(item.id, { text: "hi" });
    archived.add("a");
    await engine.deliver();
    expect(item.delivery).toBe("undeliverable");
    expect(item.status).toBe("answered");
    expect(sent).toHaveLength(0);
    expect(engine.store.events().at(-1)?.type).toBe("undeliverable");
  });

  it("holds messages for an agent with a pending permission request", async () => {
    const { engine, sent } = setup();
    const { item } = engine.ask({ agentId: "a", question: "q" });
    engine.answer(item.id, { text: "hi" });
    engine.permission("a", true);
    await engine.deliver();
    expect(sent).toHaveLength(0);
    engine.permission("a", false);
    await engine.deliver();
    expect(sent).toHaveLength(1);
  });
});

describe("expiry, withdrawal, archive", () => {
  it("answers with the default after expiry and wakes the asker", async () => {
    const { engine, sent, advance } = setup();
    const { item } = engine.ask({ agentId: "a", question: "q", options: [{ id: "n", label: "No" }], expiresInMinutes: 10, defaultAnswer: "n" });
    advance(9 * 60_000);
    await engine.tick();
    expect(item.status).toBe("pending");
    advance(2 * 60_000);
    await engine.tick();
    expect(item.status).toBe("answered");
    expect(item.answer?.by).toBe("default");
    expect(sent[0].text).toContain("by default after expiry");
    expect(engine.answer(item.id, { optionId: "n" }).ok).toBe(false);
  });

  it("tells the asker about an expiry without default", async () => {
    const { engine, sent, advance } = setup();
    const { item } = engine.ask({ agentId: "a", question: "q", expiresInMinutes: 1 });
    advance(2 * 60_000);
    await engine.tick();
    expect(item.status).toBe("expired");
    expect(sent[0].text).toContain("expired");
  });

  it("lets the asker withdraw, once", () => {
    const { engine } = setup();
    const { item } = engine.ask({ agentId: "a", question: "q" });
    engine.withdraw(item, "a", "moot");
    expect(item.status).toBe("withdrawn");
    expect(() => engine.withdraw(item, "a", null)).toThrow(UsageError);
    expect(engine.answer(item.id, { text: "late" }).ok).toBe(false);
  });

  it("withdraws questions of an archived agent, by event and by sweep", async () => {
    const archived = new Set<string>();
    const { engine } = setup({ archived });
    const a = engine.ask({ agentId: "a", question: "q" }).item;
    const b = engine.ask({ agentId: "b", question: "q" }).item;
    engine.agentArchived("a");
    expect(a.status).toBe("archived");
    archived.add("b");
    await engine.tick();
    expect(b.status).toBe("archived");
  });
});

describe("counts and restart", () => {
  it("counts unread pending items", () => {
    const { engine } = setup();
    const a = engine.ask({ agentId: "a", question: "q1" }).item;
    engine.ask({ agentId: "a", question: "q2" });
    expect(engine.count()).toEqual({ pending: 2, unread: 2 });
    engine.markRead(a.id);
    expect(engine.count()).toEqual({ pending: 2, unread: 1 });
  });

  it("re-delivers an answer after a restart", async () => {
    const dir = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/inbox-");
    const file = `${dir}/state.json`;
    const sent: string[] = [];
    const actions: Actions = { send: async (_a, t) => void sent.push(t), isArchived: async () => false };
    const settings = () => settingsSchema.parse({ globalGapSeconds: 0 });
    const first = new Engine(new Store(file), actions, settings);
    const { item } = first.ask({ agentId: "a", question: "q" });
    first.answer(item.id, { text: "yes" });
    const second = new Engine(new Store(file), actions, settings);
    await second.tick();
    expect(sent).toHaveLength(1);
    expect(second.store.get(item.id)?.delivery).toBe("sent");
    expect(new Engine(new Store(file), actions, settings).store.events().map((e) => e.type)).toEqual(["asked", "answered", "delivered"]);
  });
});
