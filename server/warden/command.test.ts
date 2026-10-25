import { describe, expect, it } from "vitest";
import { settingsSchema } from "../../shared/warden/settings";
import { parseCommand, runCommand } from "./command";
import { Engine, type Actions } from "./engine";
import { Store } from "./store";

const MIN = 60_000;

function setup(quiet = false) {
  let t = 1_000_000;
  const sent: { to: string; text: string }[] = [];
  const watched = new Set<string>();
  const actions: Actions = {
    async send(to, text) {
      if (!quiet || !text.includes("put you under watch")) sent.push({ to, text });
    },
    watch: (id) => void watched.add(id),
    unwatch: (id) => void watched.delete(id),
  };
  const settings = settingsSchema.parse({ globalGapSeconds: 1 });
  const store = new Store(null);
  store.upsertAgent("boss", { title: "boss" });
  const engine = new Engine(store, actions, () => settings, () => t);
  return { engine, store, sent, watched, advance: (ms: number) => (t += ms) };
}

describe("parseCommand", () => {
  it("parses the forms", () => {
    expect(parseCommand("")).toEqual({ kind: "status" });
    expect(parseCommand("stop").kind).toBe("stop");
    expect(parseCommand("done").kind).toBe("stop");
    expect(parseCommand("supervise")).toMatchObject({ kind: "watch", task: "Supervising child agents" });
    expect(parseCommand("supervise stop").kind).toBe("stop");
    expect(parseCommand("wait for CI")).toEqual({ kind: "watch", task: "wait for CI", intervalMinutes: undefined });
    expect(parseCommand("--interval 5 wait for CI")).toMatchObject({ task: "wait for CI", intervalMinutes: 5 });
    expect(parseCommand("wait for CI --interval=7m")).toMatchObject({ task: "wait for CI", intervalMinutes: 7 });
  });
  it("rejects a bad interval or an empty task", () => {
    expect(() => parseCommand("x --interval soon")).toThrow(/--interval/);
    expect(() => parseCommand("--interval 5")).toThrow(/Usage/);
  });
});

describe("runCommand", () => {
  it("registers a task as the user, steers the agent, then stops it", async () => {
    const { engine, store, sent, watched } = setup();
    const message = await runCommand(engine, "a", parseCommand("deploy --interval 5"));
    const [task] = store.active("a");
    expect(task).toMatchObject({ registeredBy: "user", source: "user", intervalMinutes: 5, task: "deploy" });
    expect(watched.has("a")).toBe(true);
    expect(message).toContain("watching");
    expect(sent[0].to).toBe("a");
    expect(sent[0].text).toContain(`warden_done with task_id ${task.id}`);
    expect(engine.views()[0].registeredBy).toBe("user");

    expect(await runCommand(engine, "a", parseCommand(""))).toContain("deploy");
    await runCommand(engine, "a", parseCommand("stop"));
    expect(store.active("a")).toEqual([]);
    expect(store.get(task.id)?.state).toBe("cancelled");
    expect(sent).toHaveLength(2);
    expect(await runCommand(engine, "a", parseCommand("stop"))).toContain("nothing to stop");
  });

  it("pings a user-registered task 1 min after the agent stops", async () => {
    const { engine, sent, advance } = setup();
    await runCommand(engine, "a", parseCommand("deploy"));
    sent.length = 0;
    engine.turnStarted("a");
    engine.turnEnded("a");
    advance(2 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("not finished");
  });
});

const sup = (engine: Engine) => engine.views().find((v) => v.agentId === "boss" && v.status !== "cancelled")!;

describe("supervise (a normal watch)", () => {
  const child = (store: Store, id: string, parent = "boss") => store.upsertAgent(id, { title: `child ${id}`, parentId: parent });

  it("stays silent while a child runs, even when the coordinator itself idles", async () => {
    const { engine, store, sent, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.turnStarted("c1");
    engine.turnStarted("boss");
    engine.turnEnded("boss");
    advance(10 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
  });

  it("pings after the react delay when a child finishes, once", async () => {
    const { engine, store, sent, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.childSeen("c1");
    engine.turnStarted("c1");
    advance(MIN);
    engine.turnEnded("c1");
    advance(4 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    advance(2 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("boss");
    expect(sent[0].text).toContain("child c1");
    expect(sent[0].text).toContain("finished its turn");
    advance(30 * MIN);
    engine.activity("boss");
    await engine.tick();
    expect(sent).toHaveLength(1);
  });

  it("does not ping when the coordinator prompted the child, but not for warden's own message", async () => {
    const { engine, store, sent, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    child(store, "c2");
    for (const id of ["c1", "c2"]) {
      engine.turnStarted(id);
      engine.turnEnded(id);
    }
    advance(MIN);
    engine.userMessage("c1");
    advance(6 * MIN);
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("child c2");
    expect(sent[0].text).not.toContain("child c1");
  });

  it("shows the same facts as a task: turn, pings, unanswered, react delay", async () => {
    const { engine, store, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.turnEnded("boss");
    expect(sup(engine)).toMatchObject({ turn: "idle", pings: 0, unanswered: 0 });
    engine.turnStarted("c1");
    engine.turnEnded("c1");
    advance(6 * MIN);
    await engine.tick();
    expect(sup(engine)).toMatchObject({ pings: 1, unanswered: 1 });
    engine.turnStarted("boss");
    expect(sup(engine)).toMatchObject({ turn: "running", pings: 1, unanswered: 0 });
  });

  it("flags a permission request, clears when answered, and a hung running child", async () => {
    const { engine, store, sent, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    child(store, "c2");
    engine.turnStarted("c1");
    engine.turnStarted("c2");
    engine.permission("c1", true);
    advance(6 * MIN);
    await engine.tick();
    expect(sent[0].text).toContain("permission request");
    expect(sup(engine)).toMatchObject({ children: 2, needAttention: 1 });
    engine.permission("c1", false);
    expect(sup(engine).needAttention).toBe(0);
    advance(10 * MIN);
    expect(sup(engine).needAttention).toBe(0); // hang check + react not reached yet
    advance(6 * MIN);
    engine.activity("c1");
    await engine.tick();
    expect(sent.at(-1)!.text).toContain("child c2");
    expect(sent.at(-1)!.text).toContain("no activity");
  });

  it("ignores archived children and stops on /warden supervise stop", async () => {
    const { engine, store, sent, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.turnStarted("c1");
    engine.turnEnded("c1");
    engine.agentArchived("c1");
    advance(10 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(sup(engine).children).toBe(0);
    await runCommand(engine, "boss", parseCommand("supervise stop"));
    expect(engine.views().filter((v) => v.status !== "cancelled")).toEqual([]);
  });

  it("does not re-ping after a child's reply to the coordinator's own message", async () => {
    const { engine, store, sent, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.turnStarted("c1");
    engine.turnEnded("c1");
    advance(MIN);
    engine.userMessage("c1"); // the coordinator answers
    engine.turnStarted("c1");
    advance(MIN);
    engine.turnEnded("c1"); // reply, no new work
    advance(20 * MIN);
    engine.activity("boss");
    await engine.tick();
    expect(sent).toEqual([]);
    expect(sup(engine).needAttention).toBe(0);
  });

  it("still flags a reply turn that left a task open", async () => {
    const { engine, store, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.turnStarted("c1");
    engine.turnEnded("c1");
    advance(MIN);
    engine.userMessage("c1");
    engine.turnStarted("c1");
    engine.register({ agentId: "c1", task: "wait", intervalMinutes: 10, until: null, registeredBy: "c1", source: "agent" });
    advance(MIN);
    engine.turnEnded("c1");
    advance(6 * MIN);
    expect(sup(engine).needAttention).toBe(1);
  });

  it("does not re-flag a child whose parent-triggered reply turn only acknowledged, even with an older task open", async () => {
    const { engine, store, sent, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.register({ agentId: "c1", task: "wait for CI", intervalMinutes: 10, until: null, registeredBy: "c1", source: "agent" });
    engine.turnStarted("c1");
    engine.turnEnded("c1");
    advance(10 * MIN);
    engine.userMessage("c1"); // the parent acknowledges
    engine.turnStarted("c1");
    advance(MIN);
    engine.turnEnded("c1"); // the child answers; its old task is still open
    advance(30 * MIN);
    engine.activity("boss");
    expect(sup(engine).needAttention).toBe(0);
    await engine.tick();
    expect(sent.filter((m) => m.to === "boss")).toEqual([]);
  });

  it("a waiting mark suppresses idle attention until cleared or new input", async () => {
    const { engine, store, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    advance(1);
    child(store, "c1");
    engine.turnStarted("c1");
    engine.turnEnded("c1");
    engine.setWaiting("c1", "CI");
    advance(20 * MIN);
    expect(sup(engine).needAttention).toBe(0);
    engine.setWaiting("c1", null);
    expect(sup(engine).needAttention).toBe(1);
    engine.setWaiting("c1", "CI");
    expect(sup(engine).needAttention).toBe(0);
    engine.userMessage("c1");
    expect(store.agent("c1")?.waitingOn).toBeNull();
  });

  it("is a normal task and pings the idle coordinator 1 min after it stops, unless a child runs", async () => {
    const { engine, store, sent, advance } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    expect(store.active("boss")[0].task).toBe("Supervising child agents");
    child(store, "c1");
    engine.turnStarted("c1");
    engine.turnStarted("boss");
    engine.turnEnded("boss");
    advance(2 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
    expect(sup(engine).nextPing?.reason).toContain("subagent");
    engine.turnEnded("c1");
    advance(2 * MIN);
    await engine.tick();
    expect(sent.map((m) => m.to)).toEqual(["boss"]);
    expect(sent[0].text).toContain("not finished");
  });

  it("does not idle-ping a coordinator marked waiting, and reports the next ping", async () => {
    const { engine, advance, sent } = setup(true);
    engine.register({ agentId: "boss", task: "x", intervalMinutes: 10, until: null, registeredBy: "boss", source: "agent" });
    engine.turnStarted("boss");
    engine.turnEnded("boss");
    expect(sup(engine).nextPing).toMatchObject({ reason: "it stopped without finishing" });
    engine.setWaiting("boss", "CI");
    expect(sup(engine).nextPing).toBeNull();
    advance(10 * MIN);
    await engine.tick();
    expect(sent).toEqual([]);
  });

  it("counts only live children", async () => {
    const { engine, store } = setup(true);
    await runCommand(engine, "boss", parseCommand("supervise"));
    child(store, "c1");
    child(store, "c2");
    engine.agentArchived("c2");
    expect(sup(engine).children).toBe(1);
  });
});
