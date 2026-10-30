import { describe, expect, it } from "vitest";
import { settingsSchema } from "../../shared/inbox/settings";
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
    // "Other" is always open, so a free-text default is fine
    expect(() => engine.ask({ agentId: "a", question: "q2", options: [{ id: "y", label: "Y" }], expiresInMinutes: 5, defaultAnswer: "n" })).not.toThrow();
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
    expect(engine.answer(item.id, {}).ok).toBe(false);
    expect(engine.answer(item.id, { text: "hmm, other" }).item?.answer).toMatchObject({ optionId: null, text: "hmm, other" });
    const free = engine.ask({ agentId: "a", question: "Why?" }).item;
    expect(engine.answer(free.id, { text: " because " }).item?.answer?.text).toBe("because");
  });
});

describe("multiple choice", () => {
  it("shows the recommended option first and always allows an Other answer", () => {
    const { engine } = setup();
    const { item } = engine.ask({ agentId: "a", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B", recommended: true, description: "safer" }] });
    expect(item.options.map((o) => o.id)).toEqual(["b", "a"]);
    expect(item.options[0].description).toBe("safer");
    expect(item.allowFreeText).toBe(true);
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

describe("new item mail", () => {
  const settingsOf = (to: string) => settingsSchema.parse({ globalGapSeconds: 0, notifyMailTo: to });

  it("is off by default", () => {
    expect(settingsSchema.parse({}).notifyMailTo).toBe("");
  });

  it("is a short mail: id, asker, kind, options with the recommended one, the question clipped, never the context", async () => {
    const { newItemMail } = await import("./notify");
    const { engine } = setup();
    const { item } = engine.ask({ agentId: "a1", question: `Which?\n${"x".repeat(500)}`, options: [{ id: "a", label: "A" }, { id: "b", label: "B", recommended: true }], context: "SECRET CONTEXT" });
    const m = newItemMail(item, "Worker (a1)");
    expect(m.subject).toBe(`Inbox ${item.id} new: Which? ${"x".repeat(80 - 8)}…`);
    expect(m.body.split("\n").length).toBeLessThanOrEqual(5);
    expect(m.body).toContain("Asked by: Worker (a1)");
    expect(m.body).toContain("Options: B (recommended), A");
    expect(m.body).not.toContain("SECRET");
  });

  it("is sent once per new item, not for a deduped ask, and survives a restart", async () => {
    const { notifyNewItem } = await import("./notify");
    const dir = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/inbox-");
    const file = `${dir}/state.json`;
    const actions: Actions = { send: async () => {}, isArchived: async () => false };
    const mails: { to: string; subject: string }[] = [];
    const wire = (engine: Engine, eventsMailTo = "") =>
      engine.onAsked((item) => notifyNewItem(item, { to: "@assistant", eventsMailTo, askedBy: "w", send: async (to, m) => void mails.push({ to, subject: m.subject }), save: () => engine.store.save() }));
    const first = new Engine(new Store(file), actions, () => settingsOf("@assistant"));
    wire(first);
    const a = first.ask({ agentId: "a", question: "q" });
    first.ask({ agentId: "a", question: "q" });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("@assistant");
    const second = new Engine(new Store(file), actions, () => settingsOf("@assistant"));
    wire(second);
    expect(second.store.get(a.item.id)?.notified).toBe(true);
    second.ask({ agentId: "a", question: "q" });
    expect(mails).toHaveLength(1);
    second.ask({ agentId: "b", question: "q" });
    expect(mails).toHaveLength(2);
  });

  it("a blueprint gate is skipped while events.mailTo is set (its gate mail covers it), mailed otherwise", async () => {
    const { notifyNewItem } = await import("./notify");
    const { engine } = setup();
    const mails: string[] = [];
    const send = async (_to: string, m: { subject: string }) => void mails.push(m.subject);
    const covered = engine.ask({ agentId: "blueprint:r1", question: "Gate?", internal: true }).item;
    notifyNewItem(covered, { to: "@assistant", eventsMailTo: "@assistant", askedBy: "x", send, save() {} });
    expect(mails).toHaveLength(0);
    const alone = engine.ask({ agentId: "blueprint:r1", question: "Gate 2?", internal: true }).item;
    notifyNewItem(alone, { to: "@assistant", eventsMailTo: "", askedBy: "x", send, save() {} });
    expect(mails).toHaveLength(1);
  });

  it("a failing mailbox is logged and never blocks the ask", async () => {
    const { notifyNewItem } = await import("./notify");
    const { engine } = setup();
    engine.onAsked((item) => notifyNewItem(item, { to: "@assistant", eventsMailTo: "", askedBy: "x", send: () => Promise.reject(new Error("down")), save() {} }));
    expect(engine.ask({ agentId: "a", question: "q" }).deduped).toBe(false);
    await new Promise((r) => setImmediate(r));
  });
});

describe("inform (information items)", () => {
  it("files a non-blocking item from the Factory with one 'Got it' choice, deduped while pending", () => {
    const { engine, store } = setup();
    const asked: string[] = [];
    engine.onAsked((i) => asked.push(i.id));
    const a = engine.inform({ title: "Factory retro bp-1", body: "Timeline...", dedupeKey: "retro:bp-1" });
    expect(a.item).toMatchObject({ agentId: "factory", kind: "info", blocking: false, allowFreeText: false, internal: true, expiresAt: null, context: "Timeline..." });
    expect(a.item.options).toEqual([{ id: "ack", label: "Got it" }]);
    expect(store.agent("factory")?.title).toBe("Factory");
    expect(engine.inform({ title: "again", body: "", dedupeKey: "retro:bp-1" }).deduped).toBe(true);
    expect(asked).toEqual([a.item.id]);
  });

  it("'Got it' closes it and nobody is messaged", async () => {
    const { engine, sent } = setup();
    const { item } = engine.inform({ title: "notice", body: "b" });
    expect(engine.answer(item.id, { text: "free text" }).ok).toBe(false);
    expect(engine.answer(item.id, { optionId: "ack" }).ok).toBe(true);
    await engine.deliver();
    expect(sent).toHaveLength(0);
    expect(engine.views().find((v) => v.id === item.id)).toMatchObject({ kind: "info", status: "answered", delivery: "none" });
  });
});
