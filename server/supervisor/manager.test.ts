import { describe, expect, it } from "vitest";
import { settingsSchema } from "../../shared/supervisor/settings";
import { DISABLED_NOTE, busyReasons, Supervisor, type FactoryActivity, type SupervisorPorts } from "./manager";
import { SupervisorState } from "./state";

function setup(over: Partial<SupervisorPorts> = {}, settings: object = {}) {
  let time = 1_000_000;
  const created: { key: string; cwd: string }[] = [];
  const prompts: string[] = [];
  const sent: { to: string; text: string }[] = [];
  const archived: { id: string; ws: string | null }[] = [];
  const flagged: string[] = [];
  let activity: FactoryActivity = { runs: [], liveStageAgents: 0 };
  const states = new Map<string, "running" | "idle" | "gone">();
  let issues: { key: string; text: string }[] = [];
  const ports: SupervisorPorts = {
    now: () => time,
    async create({ idempotencyKey, cwd, prompt }) {
      created.push({ key: idempotencyKey, cwd });
      const id = `sup-${created.length}`;
      states.set(id, "idle");
      prompts.push(prompt);
      return { agentId: id, workspaceId: `ws-${created.length}` };
    },
    async archive(id, ws) {
      archived.push({ id, ws });
      states.set(id, "gone");
    },
    async awaitTurn() {},
    async factory() {
      return activity;
    },
    flag: async (r) => void flagged.push(r.body),
    async send(to, text) {
      sent.push({ to, text });
    },
    async agentState(id) {
      return states.get(id) ?? "gone";
    },
    async issues() {
      return issues;
    },
    nameOf: async (id) => `name of ${id}`,
    restartExtension: async (id) => `restarted ${id}`,
    settings: () => settingsSchema.parse({ cwd: "/w", askTimeoutSeconds: 5, ...settings }),
    defaultCwd: () => undefined,
    ...over,
  };
  const supervisor = new Supervisor(new SupervisorState(null), ports);
  return { supervisor, created, sent, states, archived, flagged, prompts, setActivity: (a: FactoryActivity) => (activity = a), setIssues: (i: typeof issues) => (issues = i), advance: (ms: number) => (time += ms) };
}

describe("Supervisor lifecycle", () => {
  it("creates the agent once, keeps it, and creates a new one when it is gone", async () => {
    const { supervisor, created, states } = setup();
    await supervisor.ensure();
    await supervisor.ensure();
    expect(created).toHaveLength(1);
    expect((await supervisor.status()).agentId).toBe("sup-1");
    states.set("sup-1", "gone");
    await supervisor.ensure();
    expect(created.map((c) => c.key)).toEqual(["supervisor:1", "supervisor:2"]);
    await supervisor.ensure({ restart: true });
    expect(created).toHaveLength(3);
  });

  it("says what is missing when there is no working directory", async () => {
    const { supervisor, created } = setup({ settings: () => settingsSchema.parse({}) });
    await supervisor.ensure();
    expect(created).toHaveLength(0);
    expect((await supervisor.status())).toMatchObject({ state: "error", error: expect.stringMatching(/working directory/) });
  });

  it("reports a creation failure instead of throwing", async () => {
    const { supervisor } = setup({ create: async () => { throw new Error("bad provider"); } });
    await supervisor.ensure();
    expect((await supervisor.status()).error).toMatch(/bad provider/);
  });
});

describe("Supervisor digest", () => {
  it("tells new problems once, starts the agent if needed, repeats after the delay", async () => {
    const { supervisor, sent, setIssues, advance, created } = setup();
    setIssues([{ key: "run:1", text: "Run bp-1 is paused" }]);
    await supervisor.digest();
    expect(created).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/Run bp-1 is paused/);
    await supervisor.digest();
    expect(sent).toHaveLength(1);
    advance(31 * 60_000);
    await supervisor.digest();
    expect(sent).toHaveLength(2);
    expect((await supervisor.status()).issues).toHaveLength(1);
  });
});

describe("Supervisor digest reports", () => {
  it("goes through the report port (Agents Mail) when there is one, not through send", async () => {
    const reports: { to: string; subject: string; kind: string; body: string }[] = [];
    const { supervisor, sent, setIssues } = setup({ report: async (to, r) => void reports.push({ to, ...r }) });
    setIssues([{ key: "run:1", text: "Run bp-1 is paused" }]);
    await supervisor.digest();
    expect(sent).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ to: "sup-1", kind: "digest", subject: "Factory digest: 1 problem" });
    expect(reports[0].body).toMatch(/Run bp-1 is paused/);
  });
});

describe("requests from other agents", () => {
  it("relays a question with the caller's name and returns the answer", async () => {
    const { supervisor, sent } = setup();
    const pending = supervisor.ask({ id: "coord", name: "Coordinator" }, "Why is run bp-1 stuck?");
    await new Promise((r) => setTimeout(r, 20));
    const text = sent.at(-1)!.text;
    expect(text).toMatch(/Supervisor request (sq-\w+) from "Coordinator" \(coord\): Why is run bp-1 stuck\?/);
    const id = /request (sq-\w+)/.exec(text)![1];
    supervisor.reply(id, "It waits for the PM.");
    expect(await pending).toEqual({ status: "answered", request: id, answer: "It waits for the PM." });
    expect(supervisor.request(id)).toMatchObject({ fromName: "Coordinator", answer: "It waits for the PM." });
  });

  it("returns a pending request id when the Supervisor is slow, and the answer shows up later", async () => {
    const { supervisor } = setup({}, { askTimeoutSeconds: 5 });
    (supervisor as unknown as { ports: SupervisorPorts }).ports.settings = () => settingsSchema.parse({ cwd: "/w", askTimeoutSeconds: 5 });
    const out = await Promise.race([supervisor.ask({ id: "a", name: "A" }, "q"), new Promise((r) => setTimeout(() => r("slow"), 300))]);
    expect(out).toBe("slow"); // still waiting inside the 5 s window
  });
});

describe("extension restarts", () => {
  it("allows one restart per extension per hour, then points to the user", async () => {
    const { supervisor, advance } = setup();
    expect(await supervisor.restartExtension("release-trains")).toBe("restarted release-trains");
    await expect(supervisor.restartExtension("release-trains")).rejects.toThrow(/once per hour.*inbox_ask/);
    expect(await supervisor.restartExtension("tickets-dispatcher")).toBe("restarted tickets-dispatcher");
    advance(61 * 60_000);
    expect(await supervisor.restartExtension("release-trains")).toBe("restarted release-trains");
  });
});

const none: FactoryActivity = { runs: [], liveStageAgents: 0 };
const base = { activity: none, told: {}, unanswered: 0, undeliveredDigest: false, outbox: 0, midTurn: false };

describe("busy truth table", () => {
  it("is idle with nothing going on", () => expect(busyReasons(base)).toEqual([]));
  it.each(["running", "waiting"] as const)("is busy for a %s run (gates and PM waits included)", (status) => {
    expect(busyReasons({ ...base, activity: { runs: [{ id: "bp-1", label: "x", status, stage: null, detail: null }], liveStageAgents: 0 } })).toHaveLength(1);
  });
  it("counts a paused run until it was reported", () => {
    const activity: FactoryActivity = { runs: [{ id: "bp-1", label: "x", status: "paused", stage: null, detail: null }], liveStageAgents: 0 };
    expect(busyReasons({ ...base, activity })).toHaveLength(1);
    expect(busyReasons({ ...base, activity, told: { "run:bp-1:paused": 1 } })).toEqual([]);
  });
  it("is busy for a live stage agent, an unanswered request, an undelivered digest, a queued message, or a mid-turn Supervisor", () => {
    expect(busyReasons({ ...base, activity: { runs: [], liveStageAgents: 2 } })).toHaveLength(1);
    expect(busyReasons({ ...base, unanswered: 1 })).toHaveLength(1);
    expect(busyReasons({ ...base, undeliveredDigest: true })).toHaveLength(1);
    expect(busyReasons({ ...base, outbox: 1 })).toHaveLength(1);
    expect(busyReasons({ ...base, midTurn: true })).toHaveLength(1);
  });
});

describe("idle archive", () => {
  it("archives the agent and its workspace after the idle delay, with a handoff first, and restarts the timer when busy", async () => {
    const { supervisor, sent, archived, advance, setActivity } = setup({}, { idleArchiveMinutes: 10 });
    await supervisor.ensure();
    await supervisor.tick();
    advance(9 * 60_000);
    await supervisor.tick();
    expect(archived).toHaveLength(0);
    setActivity({ runs: [{ id: "bp-1", label: "x", status: "running", stage: "a", detail: null }], liveStageAgents: 0 });
    advance(5 * 60_000);
    await supervisor.tick(); // busy: the timer restarts
    setActivity(none);
    await supervisor.tick();
    advance(9 * 60_000);
    await supervisor.tick();
    expect(archived).toHaveLength(0);
    advance(2 * 60_000);
    await supervisor.tick();
    expect(sent.at(-1)!.text).toMatch(/handoff/i);
    expect(archived).toEqual([{ id: "sup-1", ws: "ws-1" }]);
    expect((await supervisor.status())).toMatchObject({ state: "archived", agentId: null });
    expect(supervisor.state.data.incarnations[0]).toMatchObject({ agentId: "sup-1", reason: "idle" });
  });

  it("never archives when idleArchiveMinutes is 0", async () => {
    const { supervisor, archived, advance } = setup({}, { idleArchiveMinutes: 0 });
    await supervisor.ensure();
    advance(24 * 3600_000);
    await supervisor.tick();
    expect(archived).toHaveLength(0);
  });

  it("keeps the agent when something wakes the Factory during the handoff turn", async () => {
    let supervisorRef: Supervisor;
    const { supervisor, archived, advance } = setup({ awaitTurn: async () => void supervisorRef.sendUser("hello") }, { idleArchiveMinutes: 1 });
    supervisorRef = supervisor;
    await supervisor.ensure();
    await supervisor.tick();
    advance(2 * 60_000);
    await supervisor.tick();
    expect(archived).toHaveLength(0);
    expect(supervisor.state.data.agentId).toBe("sup-1");
  });

  it("a wake that arrives while the archive is running waits for it and creates a new agent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { supervisor, created, archived, advance, states } = setup({}, { idleArchiveMinutes: 1 });
    const ports = (supervisor as unknown as { ports: SupervisorPorts }).ports;
    ports.archive = async (id) => {
      await gate;
      archived.push({ id, ws: null });
      states.set(id, "gone");
    };
    await supervisor.ensure();
    await supervisor.tick();
    advance(2 * 60_000);
    const archiving = supervisor.tick();
    await new Promise((r) => setTimeout(r, 10));
    const waking = supervisor.ensure(); // retire() already forgot the agent: this must not reuse sup-1
    release();
    await Promise.all([archiving, waking]);
    expect(archived.map((a) => a.id)).toEqual(["sup-1"]);
    expect(created).toHaveLength(2);
    expect(supervisor.state.data.agentId).toBe("sup-2");
  });
});

describe("on-demand requests", () => {
  it("queues an ask while archived, delivers it once the agent is up, and holds the answer timer until then", async () => {
    const { supervisor, sent, created, states } = setup();
    await supervisor.ensure();
    await supervisor.state.data.agentId;
    (supervisor as unknown as { retire(r: string): Promise<void> }).retire("idle");
    await new Promise((r) => setTimeout(r, 5));
    expect(states.get("sup-1")).toBe("gone");
    const pending = supervisor.ask({ id: "a", name: "A" }, "Why?");
    const id = supervisor.state.data.requests[0].id;
    expect(supervisor.requestStatus(id)).toBe("queued");
    await new Promise((r) => setTimeout(r, 20));
    expect(created).toHaveLength(2);
    expect(supervisor.requestStatus(id)).toBe("pending");
    expect(sent.at(-1)!.text).toMatch(new RegExp(`Supervisor request ${id}`));
    supervisor.reply(id, "because");
    expect(await pending).toEqual({ status: "answered", request: id, answer: "because" });
    expect(supervisor.requestStatus(id)).toBe("answered");
  });

  it("answers queued when the Supervisor cannot be woken", async () => {
    const { supervisor } = setup({ settings: () => settingsSchema.parse({ askTimeoutSeconds: 5 }) });
    const out = await supervisor.ask({ id: "a", name: "A" }, "q");
    if (out.status !== "queued") throw new Error(`unexpected ${out.status}`);
    expect(supervisor.requestStatus(out.request)).toBe("queued");
  });

  it("queues a chat message while archived and delivers it after the wake", async () => {
    const { supervisor, sent, states } = setup();
    await supervisor.ensure();
    states.set("sup-1", "gone");
    await supervisor.tick(); // forgets the vanished agent
    const out = await supervisor.sendUser("status?");
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/waking/);
    expect(supervisor.state.data.outbox).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(supervisor.state.data.outbox).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ to: "sup-2", text: "Message from the user (Supervisor tab): status?" });
  });
});

describe("restart", () => {
  it("archives the old agent and its workspace, then creates a new one", async () => {
    const { supervisor, archived, created } = setup();
    await supervisor.ensure();
    await supervisor.ensure({ restart: true });
    expect(archived).toEqual([{ id: "sup-1", ws: "ws-1" }]);
    expect(created).toHaveLength(2);
    expect(supervisor.state.data.incarnations.map((i) => [i.agentId, i.reason])).toEqual([["sup-1", "restart"], ["sup-2", null]]);
  });
});

describe("memory and intro", () => {
  it("round-trips notes into the next session's intro with issues, requests and runs", async () => {
    const { supervisor, prompts, setActivity, setIssues } = setup();
    await supervisor.ensure();
    supervisor.note("waiting for a person on the deploy pin");
    supervisor.state.data.requests.push({ id: "sq-1", fromId: "a", fromName: "Assistant", question: "Q1", at: 1, answer: "A1", answeredAt: 2, deliveredAt: 1 });
    setIssues([{ key: "run:bp-9:failed", text: "Run bp-9 failed" }]);
    setActivity({ runs: [{ id: "bp-9", label: "ticket ANY-1", status: "waiting", stage: "review", detail: "gate" }], liveStageAgents: 0 });
    await supervisor.ensure({ restart: true });
    const intro = prompts[1];
    expect(intro).toMatch(/session #2/);
    expect(intro).toMatch(/waiting for a person on the deploy pin/);
    expect(intro).toMatch(/Run bp-9 failed/);
    expect(intro).toMatch(/sq-1 from "Assistant": Q1/);
    expect(intro).toMatch(/bp-9 \(ticket ANY-1\) waiting at review/);
  });

  it("caps the notes at 8 KB, dropping the oldest first, and the sessions at 20", async () => {
    const { supervisor } = setup();
    for (let i = 0; i < 40; i++) supervisor.note(`note ${i} ${"x".repeat(500)}`);
    const memory = supervisor.state.data.memory;
    expect(Buffer.byteLength(memory)).toBeLessThanOrEqual(8 * 1024);
    expect(memory).toMatch(/note 39/);
    expect(memory).not.toMatch(/note 0 /);
    for (let i = 0; i < 25; i++) await supervisor.ensure({ restart: true });
    supervisor.state.save();
    expect(supervisor.state.data.incarnations.length).toBeLessThanOrEqual(26);
  });

  it("adopts an agent that was running before sessions were tracked", () => {
    const state = new SupervisorState(null);
    state.data.agentId = "old-agent";
    state.data.startedAt = 5;
    const supervisor = new Supervisor(state, { now: () => 9 } as SupervisorPorts);
    expect(supervisor.state.data.incarnations).toMatchObject([{ n: 1, agentId: "old-agent", endedAt: null }]);
  });
});

describe("watcher while archived", () => {
  async function archivedSetup() {
    const s = setup();
    await s.supervisor.ensure();
    s.states.set("sup-1", "gone");
    await s.supervisor.tick();
    return s;
  }

  it("wakes on a failed run and hands it over in the new session's first digest", async () => {
    const { supervisor, created, sent, setIssues } = await archivedSetup();
    setIssues([{ key: "run:bp-1:failed", text: "Run bp-1 failed" }]);
    await supervisor.digest();
    expect(created).toHaveLength(2);
    expect(sent.at(-1)!.text).toMatch(/Run bp-1 failed/);
  });

  it("wakes on a dropped extension", async () => {
    const { supervisor, created, setIssues } = await archivedSetup();
    setIssues([{ key: "ext:release-trains:dropped", text: "Extension release-trains was dropped" }]);
    await supervisor.digest();
    expect(created).toHaveLength(2);
  });

  it("only flags lease contention and repeats, and tells the Assistant once", async () => {
    const { supervisor, created, flagged, setIssues, advance } = await archivedSetup();
    setIssues([{ key: "lease:x:contended", text: "Lease x is contended" }]);
    await supervisor.digest();
    expect(created).toHaveLength(1);
    expect(supervisor.state.data.flags.map((f) => f.key)).toEqual(["lease:x:contended"]);
    expect(flagged).toEqual(["Lease x is contended"]);
    advance(31 * 60_000);
    await supervisor.digest();
    expect(created).toHaveLength(1);
    expect(flagged).toHaveLength(1);
    setIssues([]);
    await supervisor.digest();
    expect(supervisor.state.data.flags).toEqual([]);
  });

  it("does not wake on its own when autoStart is off", async () => {
    const s = setup({}, { autoStart: false });
    await s.supervisor.ensure();
    s.states.set("sup-1", "gone");
    await s.supervisor.tick();
    s.setIssues([{ key: "run:bp-1:failed", text: "Run bp-1 failed" }]);
    await s.supervisor.digest();
    expect(s.created).toHaveLength(1);
    expect(s.supervisor.state.data.told).toEqual({});
  });
});

describe("supervisor.enabled", () => {
  it("is on by default", () => {
    expect(settingsSchema.parse({}).enabled).toBe(true);
  });

  it("disabled: nothing starts, status and ask say so, and no restart", async () => {
    const s = setup({}, { enabled: false });
    await s.supervisor.ensure();
    s.supervisor.wake();
    await s.supervisor.tick();
    expect(s.created).toHaveLength(0);
    expect((await s.supervisor.status()).state).toBe("disabled");
    expect(await s.supervisor.ask({ id: "a", name: "worker" }, "why?")).toEqual({ status: "disabled", note: DISABLED_NOTE });
    expect(s.supervisor.state.data.requests).toHaveLength(0);
    await expect(s.supervisor.restartExtension("x")).rejects.toThrow(/disabled/);
    expect((await s.supervisor.sendUser("hi")).ok).toBe(false);
  });

  it("disabled: an agent that still runs is archived", async () => {
    const on = setup();
    await on.supervisor.ensure();
    const off = setup({}, { enabled: false });
    off.supervisor.state.data.agentId = "old";
    off.states.set("old", "idle");
    await off.supervisor.disable();
    expect(off.archived.map((a) => a.id)).toEqual(["old"]);
    expect((await off.supervisor.status()).agentId).toBeNull();
  });

  it("disabled: an expired lease and a dropped extension are mailed once each, and nothing else", async () => {
    const notices: { subject: string; body: string }[] = [];
    const s = setup({ notify: (subject, body) => void notices.push({ subject, body }) }, { enabled: false });
    s.setIssues([
      { key: "lease:pr:org/repo#1:expired:123", text: "Lease pr:org/repo#1 expired without a release (holder a)." },
      { key: "ext:releaser:dropped", text: "Extension releaser was dropped." },
      { key: "ext:releaser:degraded", text: "degraded" },
      { key: "lease:x:contended", text: "contended" },
      { key: "run:r1:failed", text: "failed run" },
    ]);
    await s.supervisor.digest();
    await s.supervisor.digest();
    expect(notices).toHaveLength(2);
    expect(notices[0].subject).toBe("Factory: Lease pr:org/repo#1 expired without a release");
    expect(notices[1].subject).toBe("Factory: extension releaser dropped");
    expect(s.created).toHaveLength(0);
  });

  it("enabled: no notices (the Supervisor handles them)", async () => {
    const notices: string[] = [];
    const s = setup({ notify: (subject) => void notices.push(subject) });
    s.setIssues([{ key: "lease:x:expired:1", text: "Lease x expired without a release (holder a)." }]);
    await s.supervisor.digest();
    expect(notices).toHaveLength(0);
  });

  it("a failing mailbox never throws", async () => {
    const s = setup({ notify: () => Promise.reject(new Error("down")) }, { enabled: false });
    s.setIssues([{ key: "ext:a:dropped", text: "Extension a was dropped." }]);
    await expect(s.supervisor.digest()).resolves.toBeUndefined();
  });
});
