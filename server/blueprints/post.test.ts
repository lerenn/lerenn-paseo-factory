import { describe, expect, it } from "vitest";
import { Engine, type GateState, type Ports, type PostSettings } from "./engine";
import { RunStore } from "./store";
import { parseBlueprint } from "./toml";
import { buildDigest, flakesOf, isTrivial } from "./digest";
import { settingsSchema } from "../../shared/blueprints/settings";

const flow = `
version = 1
name = "flow"
confirm = ["ticket"]
[vars.ticket]
required = true
pattern = "^[A-Z]+-[0-9]+$"

[[stage]]
id = "think"
role = "investigator"
prompt = "Investigate {{ticket}}"
max_attempts = 1
[stage.on]
ok = "build"
blocked = "ask-blocked"
exhausted = "pm"

[[stage]]
id = "build"
role = "implementer"
prompt = "Build {{ticket}}"
max_attempts = 1
[stage.on]
done = "done"
blocked = "ask-blocked"
exhausted = "pm"

[[stage]]
id = "ask-blocked"
kind = "gate"
question = "{{ticket}} is blocked at {{from.stage}} ({{from.verdict}}): {{from.summary}}"
free_text = true
[stage.on]
answered = "build"
`;

type Mail = { to: string; subject: string; body: string; kind: string };

type PostOverrides = { eventsMailTo?: string; retro?: Partial<PostSettings["retro"]>; janitor?: Partial<PostSettings["janitor"]> };

function setup(post: PostOverrides = {}) {
  let time = 1_000_000;
  const settings: PostSettings = {
    eventsMailTo: post.eventsMailTo ?? "@assistant",
    retro: { enabled: true, mailTo: "@user", role: "retro", maxUsd: 0.3, timeoutMinutes: 10, skipTrivial: true, ...post.retro },
    janitor: { enabled: false, dryRun: true, ...post.janitor },
  };
  const mails: Mail[] = [];
  const spawned: Parameters<Ports["spawn"]>[0][] = [];
  const archived: string[] = [];
  const archivedWs: string[] = [];
  const states = new Map<string, "running" | "idle" | "gone">();
  const items = new Map<string, GateState>();
  const probes = new Map<string, string>();
  const behaviour = { spawnRetroFails: false, mailFails: false };
  let agents = 0;
  const store = new RunStore(null);
  const ports: Ports = {
    now: () => time,
    async spawn(o) {
      if (o.role === "retro" && behaviour.spawnRetroFails) throw new Error("no such role retro");
      const agentId = `agent-${++agents}`;
      spawned.push(o);
      states.set(agentId, "running");
      return { agentId, workspaceId: o.local ? null : `ws-${agents}` };
    },
    async send() {},
    async report(to, r) {
      if (behaviour.mailFails) throw new Error("mail down");
      mails.push({ to, ...r });
    },
    async agentState(id) {
      return states.get(id) ?? "gone";
    },
    async archive(id) {
      archived.push(id);
      states.set(id, "gone");
    },
    async archiveWorkspace(id) {
      archivedWs.push(id);
    },
    async trace(id) {
      return probes.get(id) ?? "clean";
    },
    ask(o) {
      const itemId = `item-${items.size + 1}`;
      items.set(itemId, { status: "pending", optionId: null, text: o.question, by: null });
      questions.push(o.question);
      return { itemId };
    },
    gate: (id) => items.get(id) ?? null,
    withdraw() {},
    wardenRegister: () => null,
    wardenDone() {},
    async prFacts(url) {
      return { url, exists: true, state: "open", head: "a", ci: "green", mergeable: true, draft: false, review: "" };
    },
    tool: () => null,
    stageKind: () => null,
    blueprint: () => parseBlueprint(flow),
    settings: () => ({ defaultCwd: "/w", pmRole: "pm", idleGraceSeconds: 90, archiveOnFinish: false }),
    post: () => settings,
    spend: () => ({ costUsd: 0.12, turns: 4 }),
    spendOfAgent: () => 0.05,
  };
  const questions: string[] = [];
  const engine = new Engine(store, ports);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const start = async () => {
    const run = engine.start({ blueprint: "flow", vars: { ticket: "ANY-1", ticket_confirmed: "true" }, requestedBy: "pm", ownerAgentId: "pm-agent" });
    await settle();
    return run;
  };
  states.set("pm-agent", "idle");
  const verdict = async (agent: string, v: string, summary = "") => {
    await engine.verdict(agent, { verdict: v, summary });
    await settle();
  };
  return { engine, store, mails, spawned, archived, archivedWs, states, probes, behaviour, questions, settings, start, verdict, settle, advance: (ms: number) => (time += ms), ports };
}

describe("event mails", () => {
  it("a gate waiting for a person sends one short mail with the run, the stage and the reason", async () => {
    const t = setup();
    const run = await t.start();
    await t.verdict("agent-1", "blocked", "need the staging password");
    const events = t.mails.filter((m) => m.to === "@assistant");
    expect(events).toHaveLength(1);
    expect(events[0].subject).toBe(`Factory ${run.id} waiting · ask-blocked`);
    expect(events[0].body).toContain(run.id);
    expect(events[0].body).toContain("Stage: ask-blocked");
    expect(events[0].body).toContain("need the staging password");
    expect(events[0].body.split("\n").length).toBeLessThanOrEqual(3);
    await t.engine.tick();
    await t.settle();
    expect(t.mails.filter((m) => m.to === "@assistant")).toHaveLength(1);
  });

  it("a run that goes well sends no event mail", async () => {
    const t = setup();
    await t.start();
    await t.verdict("agent-1", "ok");
    await t.verdict("agent-2", "done");
    expect(t.mails.filter((m) => m.to === "@assistant")).toHaveLength(0);
  });

  it("an exhausted stage sends one mail (also covering the wait for the PM), the final exhaustion one more and no separate failed mail", async () => {
    const t = setup();
    const run = await t.start();
    await t.engine.turnEnded("agent-1", { kind: "completed" });
    await t.settle();
    let events = t.mails.filter((m) => m.to === "@assistant");
    expect(events.map((m) => m.subject)).toEqual([`Factory ${run.id} exhausted · think`]);
    expect(events[0].body).toContain("waiting for the PM's judgement");
    await t.engine.retry(run.id, { extraAttempts: 1 });
    await t.settle();
    await t.engine.turnEnded("agent-1", { kind: "completed" });
    await t.settle();
    events = t.mails.filter((m) => m.to === "@assistant");
    expect(events.map((m) => m.subject)).toEqual([`Factory ${run.id} exhausted · think`, `Factory ${run.id} exhausted · think`]);
    expect(t.engine.require(run.id).status).toBe("failed");
  });

  it("an exhausted stage mail and the digest carry the infra flakes", async () => {
    const t = setup();
    const run = await t.start();
    for (const i of [1, 2, 3, 4]) {
      await t.engine.turnEnded(`agent-${i}`, { kind: "failed", message: "Claude Code process exited with code 137" });
      await t.settle();
    }
    const events = t.mails.filter((m) => m.to === "@assistant");
    expect(events.map((m) => m.subject)).toEqual([`Factory ${run.id} exhausted · think`]);
    expect(events[0].body).toContain("infra flakes ×4: OOMKilled / exit 137");
    const digest = buildDigest(t.engine.require(run.id), { now: 1_000_000, spend: { costUsd: 0, turns: 0 }, janitor: [] });
    expect(digest).toMatch(/Infra flakes retried for free: 3 \(OOMKilled \/ exit 137 ×3\)/);
  });

  it("an aborted run sends one aborted mail; a second abort does not repeat it", async () => {
    const t = setup();
    const run = await t.start();
    await t.engine.abort(run.id, "no longer needed");
    await t.settle();
    const events = t.mails.filter((m) => m.to === "@assistant");
    expect(events).toHaveLength(1);
    expect(events[0].subject).toBe(`Factory ${run.id} aborted · think`);
    expect(events[0].body).toContain("no longer needed");
    await expect(t.engine.abort(run.id, "again")).rejects.toThrow();
    expect(t.mails.filter((m) => m.to === "@assistant")).toHaveLength(1);
  });

  it("is off with an empty address, and a failing mailbox never blocks the run", async () => {
    const off = setup({ eventsMailTo: "" });
    const a = await off.start();
    await off.verdict("agent-1", "blocked", "x");
    expect(off.mails.filter((m) => m.subject.startsWith("Factory "))).toHaveLength(0);
    expect(off.engine.require(a.id).status).toBe("waiting");

    const down = setup();
    down.behaviour.mailFails = true;
    const b = await down.start();
    await down.verdict("agent-1", "blocked", "x");
    expect(down.engine.require(b.id).status).toBe("waiting");
  });

  it("survives a restart without mailing the same event again", async () => {
    const t = setup();
    await t.start();
    await t.verdict("agent-1", "blocked", "x");
    const again = new Engine(t.store, t.ports);
    await again.resumeAll();
    await t.settle();
    expect(t.mails.filter((m) => m.to === "@assistant")).toHaveLength(1);
  });
});

describe("factory notices", () => {
  it("mails events.mailTo with one short mail, and not at all with an empty address", () => {
    const t = setup();
    t.engine.observer.notice!("Factory: Lease x expired without a release", "Lease x expired without a release (holder a).");
    expect(t.mails.filter((m) => m.to === "@assistant" && m.subject.startsWith("Factory: Lease"))).toHaveLength(1);
    const off = setup({ eventsMailTo: "" });
    off.engine.observer.notice!("s", "b");
    expect(off.mails).toHaveLength(0);
  });
});

describe("ask-blocked names the stage that blocked", () => {
  it("quotes the verdict summary of the blocker, not of an earlier stage", async () => {
    const t = setup();
    await t.start();
    await t.verdict("agent-1", "ok", "INVESTIGATION SUMMARY");
    await t.verdict("agent-2", "blocked", "needs a database grant");
    expect(t.questions.at(-1)).toBe("ANY-1 is blocked at build (blocked): needs a database grant");
    expect(t.questions.at(-1)).not.toContain("INVESTIGATION");
  });
});

describe("retro", () => {
  async function failed(t: ReturnType<typeof setup>) {
    const run = await t.start();
    await t.engine.turnEnded("agent-1", { kind: "failed", message: "pod start timeout after 300s" });
    await t.settle();
    await t.engine.turnEnded("agent-1", { kind: "completed" });
    await t.settle();
    await t.engine.abort(run.id, "giving up").catch(() => undefined);
    await t.settle();
    return t.engine.require(run.id);
  }

  it("a run that did not go straight through gets a separate retro agent, local, with the digest and the destination", async () => {
    const t = setup();
    const run = await failed(t);
    const retro = t.spawned.find((s) => s.role === "retro")!;
    expect(retro).toBeTruthy();
    expect(retro.local).toBe(true);
    expect(retro.labels["paseo.factory.stage"]).toBe("retro");
    expect(retro.prompt).toContain('mail_send(to="@user"');
    expect(retro.prompt).toContain(`Run ${run.id}`);
    expect(retro.prompt).toContain("think");
    expect(retro.prompt).toContain("pod start timeout");
    expect(run.post?.phase).toBe("retro");
  });

  it("the retro's turn end finishes the post-run and archives the retro agent", async () => {
    const t = setup();
    const run = await failed(t);
    const agentId = run.post!.retro!.agentId!;
    t.engine.observer.retroEnded!(agentId);
    await t.settle();
    expect(run.post?.phase).toBe("done");
    expect(t.archived).toContain(agentId);
  });

  it("a retro that never ends is given up on after the timeout and archived", async () => {
    const t = setup();
    const run = await failed(t);
    await t.engine.tick();
    await t.settle();
    expect(run.post?.phase).toBe("retro");
    t.advance(11 * 60_000);
    await t.engine.tick();
    await t.settle();
    expect(run.post?.phase).toBe("done");
    expect(run.history.some((h) => h.event === "retro_timeout")).toBe(true);
    expect(t.archived).toContain(run.post!.retro!.agentId);
  });

  it("flags a retro that cost more than the cap", async () => {
    const t = setup({ retro: { maxUsd: 0.01 } });
    const run = await failed(t);
    t.engine.observer.retroEnded!(run.post!.retro!.agentId!);
    await t.settle();
    expect(run.history.some((h) => h.event === "retro_over_budget")).toBe(true);
  });

  it("a run that went straight through gets three lines and no agent", async () => {
    const t = setup();
    await t.start();
    await t.verdict("agent-1", "ok");
    await t.verdict("agent-2", "done");
    expect(t.spawned.filter((s) => s.role === "retro")).toHaveLength(0);
    const m = t.mails.find((x) => x.to === "@user")!;
    expect(m.subject).toMatch(/no retries/);
    expect(m.body.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("is not trivial when something retried, and skipTrivial=false always uses the agent", async () => {
    const t = setup({ retro: { skipTrivial: false } });
    await t.start();
    await t.verdict("agent-1", "ok");
    await t.verdict("agent-2", "done");
    expect(t.spawned.filter((s) => s.role === "retro")).toHaveLength(1);
    const u = setup();
    const run = await u.start();
    await u.engine.turnEnded("agent-1", { kind: "completed" });
    await u.settle();
    expect(isTrivial(run)).toBe(false);
  });

  it("when the retro agent cannot start, the digest itself is mailed to the user", async () => {
    const t = setup();
    t.behaviour.spawnRetroFails = true;
    const run = await failed(t);
    const m = t.mails.find((x) => x.to === "@user")!;
    expect(m.subject).toContain("no agent");
    expect(m.body).toContain(`Run ${run.id}`);
    expect(run.post?.phase).toBe("done");
  });

  it("can be switched off", async () => {
    const t = setup({ retro: { enabled: false } });
    await failed(t);
    expect(t.spawned.filter((s) => s.role === "retro")).toHaveLength(0);
    expect(t.mails.filter((m) => m.to === "@user")).toHaveLength(0);
  });

  it("the digest names gate waits, human versus agent time, rounds and flakes", async () => {
    const t = setup();
    const run = await t.start();
    t.advance(60_000);
    await t.verdict("agent-1", "blocked", "OOMKilled: container exited with code 137");
    t.advance(30 * 60_000);
    expect(t.questions).toHaveLength(1);
    const digest = buildDigest(t.engine.require(run.id), { now: 1_000_000 + 31 * 60_000, spend: { costUsd: 0.5, turns: 9 }, janitor: [] });
    expect(digest).toMatch(/Gate waits: ask-blocked 30m/);
    expect(digest).toMatch(/human gates 30m/);
    expect(digest).toMatch(/Review\/QA rounds: think blocked ×1/);
    expect(digest).toMatch(/Flakes:.*OOMKilled/);
    expect(digest).toContain("$0.50");
    expect(flakesOf(t.engine.require(run.id)).length).toBeGreaterThan(0);
  });
});

describe("janitor", () => {
  async function twoPods(janitor: { enabled: boolean; dryRun: boolean }) {
    const t = setup({ janitor, retro: { enabled: false } });
    const run = await t.start();
    await t.verdict("agent-1", "ok"); // investigator in ws-1, implementer agent-2 in ws-2
    t.probes.set("ws-2", "3 entries: M a.ts");
    await t.verdict("agent-2", "done");
    return { t, run };
  }

  it("archives every agent and workspace, dirty or not, and traces the dirty one in the history", async () => {
    const { t, run } = await twoPods({ enabled: true, dryRun: false });
    expect(t.archived.sort()).toEqual(["agent-1", "agent-2"]);
    expect(t.archivedWs.sort()).toEqual(["ws-1", "ws-2"]);
    expect(run.post?.plan?.keep).toEqual([]);
    expect(run.history.some((h) => h.event === "janitor_trace" && /ws-2: 3 entries/.test(h.detail ?? ""))).toBe(true);
  });

  it("archives even when the trace fails", async () => {
    const t = setup({ janitor: { enabled: true, dryRun: false }, retro: { enabled: false } });
    t.ports.trace = async () => {
      throw new Error("terminal failed");
    };
    await t.start();
    await t.verdict("agent-1", "ok");
    await t.verdict("agent-2", "done");
    expect(t.archived.sort()).toEqual(["agent-1", "agent-2"]);
  });

  it("dry run plans and reports, archives nothing", async () => {
    const { t, run } = await twoPods({ enabled: true, dryRun: true });
    expect(t.archived).toEqual([]);
    expect(t.archivedWs).toEqual([]);
    expect(run.post?.plan?.archive).toHaveLength(2);
    expect(t.mails.find((x) => x.to === "@user")!.body).toContain("dry run, would archive investigator");
  });

  it("is off by default: nothing is archived", async () => {
    const t = setup({ retro: { enabled: false } });
    await t.start();
    await t.verdict("agent-1", "ok");
    await t.verdict("agent-2", "done");
    expect(t.archived).toEqual([]);
  });

  it("the janitor's plan reaches the retro", async () => {
    const t = setup({ janitor: { enabled: true, dryRun: false }, retro: { skipTrivial: false } });
    await t.start();
    await t.verdict("agent-1", "ok");
    await t.verdict("agent-2", "done");
    const retro = t.spawned.find((s) => s.role === "retro")!;
    expect(retro.prompt).toContain("archiving investigator");
    // nothing is archived before the retro has ended
    expect(t.archived).toEqual([]);
  });

  it("resumes after a restart where it stopped, and does not archive twice", async () => {
    const { t, run } = await twoPods({ enabled: true, dryRun: false });
    const before = [...t.archived];
    run.post!.phase = "archive";
    await t.engine.tick();
    await t.settle();
    expect(run.post!.phase).toBe("done");
    expect(t.archived).toEqual(before);
    expect(t.archivedWs.sort()).toEqual(["ws-1", "ws-2"]);
  });

  it("a failing archive is logged and does not stop the others", async () => {
    const t = setup({ janitor: { enabled: true, dryRun: false }, retro: { enabled: false } });
    const archive = t.ports.archive;
    t.ports.archive = async (id) => {
      if (id === "agent-1") throw new Error("boom");
      return archive(id);
    };
    const run = await t.start();
    await t.verdict("agent-1", "ok");
    await t.verdict("agent-2", "done");
    expect(run.history.some((h) => h.event === "janitor_failed" && /boom/.test(h.detail ?? ""))).toBe(true);
    expect(t.archived).toEqual(["agent-2"]);
  });
});

describe("settings", () => {
  it("default to events on, retro on, janitor off and in dry run", () => {
    const s = settingsSchema.parse({});
    expect(s.events.mailTo).toBe("@assistant");
    expect(s.retro).toMatchObject({ enabled: true, mailTo: "@user", role: "retro", skipTrivial: true });
    expect(s.janitor).toEqual({ enabled: false, dryRun: true, orphanSweep: true });
    expect(settingsSchema.parse({ janitor: { enabled: true } }).janitor.dryRun).toBe(true);
  });
});
