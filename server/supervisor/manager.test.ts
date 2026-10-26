import { describe, expect, it } from "vitest";
import { settingsSchema } from "../../shared/supervisor/settings";
import { Supervisor, type SupervisorPorts } from "./manager";
import { SupervisorState } from "./state";

function setup(over: Partial<SupervisorPorts> = {}, settings: object = {}) {
  let time = 1_000_000;
  const created: { key: string; cwd: string }[] = [];
  const sent: { to: string; text: string }[] = [];
  const states = new Map<string, "running" | "idle" | "gone">();
  let issues: { key: string; text: string }[] = [];
  const ports: SupervisorPorts = {
    now: () => time,
    async create({ idempotencyKey, cwd }) {
      created.push({ key: idempotencyKey, cwd });
      const id = `sup-${created.length}`;
      states.set(id, "idle");
      return id;
    },
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
  return { supervisor, created, sent, states, setIssues: (i: typeof issues) => (issues = i), advance: (ms: number) => (time += ms) };
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
