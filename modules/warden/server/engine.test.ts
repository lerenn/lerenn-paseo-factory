import { describe, expect, it } from "vitest";
import { settingsSchema } from "../shared/settings";
import { Engine, type Actions } from "./engine";
import { Store } from "./store";

const MIN = 60_000;

function setup(overrides: Record<string, unknown> = {}) {
  let t = 1_000_000;
  const sent: { to: string; text: string }[] = [];
  const watched = new Set<string>();
  const actions: Actions = {
    async send(to, text) {
      sent.push({ to, text });
    },
    watch: (id) => void watched.add(id),
    unwatch: (id) => void watched.delete(id),
  };
  const settings = settingsSchema.parse({ globalGapSeconds: 30, ...overrides });
  const store = new Store(null);
  const engine = new Engine(store, actions, () => settings, () => t);
  return { engine, store, sent, watched, advance: (ms: number) => (t += ms) };
}

const register = (e: Engine, agentId = "a", intervalMinutes = 10, extra: Record<string, unknown> = {}) =>
  e.register({ agentId, task: "wait for CI", intervalMinutes, until: null, registeredBy: agentId, source: "agent", ...extra });

describe("backstop clamp", () => {
  it("clamps a stored long interval on load, so a hung running agent is pinged at the max", async () => {
    const { engine, store, sent, advance } = setup();
    const task = register(engine);
    task.intervalMinutes = 120; // as persisted by an older version
    engine.turnStarted("a");
    advance(16 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(engine.views()[0].intervalMinutes).toBe(15);
    expect(engine.views()[0].turn).toBe("running");
    void store;
  });
});

describe("pings", () => {
  it("pings after the interval of inactivity, with the task in the prompt", async () => {
    const { engine, sent, advance } = setup();
    register(engine);
    advance(9 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    advance(2 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("a");
    expect(sent[0].text).toBe(
      "Warden: your task 'wait for CI' has had no activity for 11 min. Continue it, or call warden_done / warden_update.",
    );
  });

  it("activity resets the timer and the unanswered count", async () => {
    const { engine, sent, advance, store } = setup();
    const task = register(engine);
    advance(11 * MIN);
    await engine.tick();
    expect(task.unanswered).toBe(1);
    engine.activity("a");
    expect(task.unanswered).toBe(0);
    advance(5 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(store.get(task.id)?.pings).toBe(1);
  });

  it("backs off between unanswered pings", async () => {
    const { engine, sent, advance } = setup({ backoffFactor: 2 });
    register(engine, "a", 10);
    advance(10 * MIN);
    await engine.tick(); // ping 1
    advance(10 * MIN);
    await engine.tick(); // wait is 20 min now
    expect(sent).toHaveLength(1);
    advance(10 * MIN);
    await engine.tick(); // ping 2
    expect(sent).toHaveLength(2);
    advance(39 * MIN);
    await engine.tick(); // wait is 40 min
    expect(sent).toHaveLength(2);
    advance(1 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(3);
  });

  it("caps the backoff", async () => {
    const { engine, advance, store, sent } = setup({ backoffFactor: 10, maxBackoffIntervals: 2, notifyParentAfterPings: 99, maxUnansweredPings: 99 });
    const task = register(engine, "a", 10);
    advance(10 * MIN);
    await engine.tick();
    advance(20 * MIN);
    await engine.tick();
    advance(20 * MIN); // capped at 2 intervals, not 100
    await engine.tick();
    expect(sent).toHaveLength(3);
    expect(store.get(task.id)?.pings).toBe(3);
  });
});

describe("global pacing", () => {
  it("sends at most one prompt per tick and per globalGapSeconds across agents", async () => {
    const { engine, sent, advance } = setup({ globalGapSeconds: 60 });
    for (let i = 0; i < 67; i++) register(engine, `agent-${i}`, 5);
    advance(6 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    advance(30_000);
    await engine.tick();
    expect(sent).toHaveLength(1); // inside the 60 s gap
    advance(31_000);
    await engine.tick();
    expect(sent).toHaveLength(2);
  });

  it("starts with the agent that has been quiet longest", async () => {
    const { engine, sent, advance } = setup();
    register(engine, "old", 5);
    advance(2 * MIN);
    register(engine, "new", 5);
    advance(10 * MIN);
    await engine.tick();
    expect(sent[0].to).toBe("old");
  });
});

describe("parent notification", () => {
  it("notifies the parent once after K unanswered pings", async () => {
    const { engine, store, sent, advance } = setup({ notifyParentAfterPings: 2, backoffFactor: 1 });
    store.upsertAgent("child", { parentId: "boss", title: "Builder" });
    register(engine, "child", 10);
    for (let i = 0; i < 2; i++) {
      advance(10 * MIN);
      await engine.tick();
    }
    advance(31_000);
    await engine.tick();
    const notices = sent.filter((s) => s.to === "boss");
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("Builder");
    expect(notices[0].text).toContain("2 pings");
    advance(31_000);
    await engine.tick();
    expect(sent.filter((s) => s.to === "boss")).toHaveLength(1);
  });

  it("gives up after maxUnansweredPings", async () => {
    const { engine, store, sent, advance } = setup({ maxUnansweredPings: 2, backoffFactor: 1, notifyParentAfterPings: 99 });
    const task = register(engine, "a", 10);
    for (let i = 0; i < 6; i++) {
      advance(11 * MIN);
      await engine.tick();
    }
    expect(sent).toHaveLength(2);
    expect(store.get(task.id)?.state).toBe("gave-up");
  });
});

describe("stopping", () => {
  it("stops when done and unwatches the agent", async () => {
    const { engine, sent, advance, watched } = setup();
    const task = register(engine);
    expect(watched.has("a")).toBe(true);
    engine.finish(task, "done", "ok");
    expect(watched.has("a")).toBe(false);
    advance(60 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(engine.status(task)).toBe("done");
  });

  it("expires at `until`", async () => {
    const { engine, sent, advance } = setup();
    const task = register(engine, "a", 10, { until: 1_000_000 + 5 * MIN });
    advance(20 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(engine.status(task)).toBe("expired");
  });

  it("stops when the agent is archived", async () => {
    const { engine, sent, advance } = setup();
    const task = register(engine);
    engine.agentArchived("a");
    advance(60 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(engine.status(task)).toBe("archived");
  });
});

describe("skips", () => {
  it("does not ping while a permission request is pending", async () => {
    const { engine, sent, advance } = setup();
    const task = register(engine);
    engine.permission("a", true);
    advance(60 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(engine.status(task)).toBe("waiting-permission");
  });

  it("skips agents that opted out, or whose parent did", async () => {
    const { engine, store, sent, advance } = setup({ globalGapSeconds: 1 });
    store.upsertAgent("boss", { optOut: true });
    store.upsertAgent("child", { parentId: "boss" });
    register(engine, "child");
    advance(60 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
  });

  it("does nothing when disabled", async () => {
    const { engine, sent, advance } = setup({ enabled: false });
    register(engine);
    advance(60 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
  });
});

describe("idle agents", () => {
  const SEC = 1000;

  it("never pings an agent whose turn is running, until the interval backstop", async () => {
    const { engine, sent, advance } = setup();
    register(engine);
    engine.turnStarted("a");
    advance(9 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    advance(2 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("no activity");
  });

  it("pings an idle agent after the grace period with the idle wording", async () => {
    const { engine, sent, advance } = setup();
    register(engine);
    engine.turnStarted("a");
    engine.turnEnded("a");
    advance(30 * SEC);
    await engine.tick();
    expect(sent).toEqual([]);
    advance(31 * SEC);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Keep working within your turn");
    expect(sent[0].text).toContain("wait for CI");
  });

  it("does not re-ping the same idle episode before the backoff, and gives up at the limit", async () => {
    const { engine, sent, advance } = setup({ maxUnansweredPings: 2, notifyParentAfterPings: 99 });
    register(engine);
    engine.turnEnded("a");
    advance(61 * SEC);
    await engine.tick();
    advance(5 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    advance(16 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(2);
    advance(120 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(2);
  });

  it("a new turn ends the idle episode", async () => {
    const { engine, sent, advance } = setup();
    register(engine);
    engine.turnEnded("a");
    advance(61 * SEC);
    engine.turnStarted("a");
    advance(5 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
  });

  it("skips idle agents waiting on a permission and shows it", async () => {
    const { engine, sent, advance } = setup();
    const task = register(engine);
    engine.turnEnded("a");
    engine.permission("a", true);
    advance(5 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(engine.status(task)).toBe("waiting-permission");
  });

  it("cleans up archived agents", async () => {
    const { engine, sent, advance, watched } = setup();
    const task = register(engine);
    engine.turnEnded("a");
    engine.agentArchived("a");
    advance(5 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(task.state).toBe("archived");
    expect(watched.has("a")).toBe(false);
  });
});
