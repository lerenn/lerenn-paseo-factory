import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { milestones, slackApi, slackEscape, SlackNotifier, type SlackAction } from "./slack";
import type { Run } from "./store";

const run = (over: Partial<Run> = {}): Run =>
  ({ id: "bp-1", blueprint: "incident", vars: { slack_channel: "C098F6E0AD6", slack_thread_ts: "1793254097.509929" }, status: "running", stages: {}, history: [], ...over }) as Run;
const stage = (over: Record<string, unknown>) => ({ status: "done", verdict: null, summary: null, data: {}, ...over }) as never;

describe("Slack milestones", () => {
  it("reacts 👀 at once, replies the diagnosis and the PR links, and swaps 👀 for ✅ on merge", () => {
    expect(milestones(run({ vars: {} as never }))).toEqual([]);
    const r = run({
      stages: {
        investigate: stage({ verdict: "fix_needed", summary: "graph-api pins @modelcontextprotocol/node 1.2.0 <@U1>" }),
        implement: stage({ data: { pr_urls: ["https://github.com/anyshift-io/graph-api/pull/7", "not a url"] } }),
        "wait-queue": stage({ verdict: "merged" }),
      },
    });
    const ms = milestones(r);
    expect(ms.map((m) => m.key.split(":").slice(2).join(":"))).toEqual(["seen", "diagnosis", "prs:https://github.com/anyshift-io/graph-api/pull/7", "merged"]);
    const diagnosis = ms[1]!.actions[0] as { text: string };
    expect(diagnosis.text).toContain("a code fix is needed");
    expect(diagnosis.text).toContain("&lt;@U1&gt;"); // no mention can be formed
    expect(ms[3]!.actions).toEqual([{ kind: "unreact", name: "eyes" }, { kind: "react", name: "white_check_mark" }]);
    expect(slackEscape("a".repeat(5000)).length).toBe(2900);
  });

  it("closes the thread once the alert's own run is done: ✅ and a free-text reply, not for a child run", () => {
    const merged = { "wait-queue": stage({ verdict: "merged" }) };
    expect(milestones(run({ status: "running", stages: merged })).some((m) => m.key.endsWith(":done"))).toBe(false);
    expect(milestones(run({ status: "done", stages: merged, parent: { runId: "bp-0", stageId: "ticket" } })).some((m) => m.key.endsWith(":done"))).toBe(false);
    const done = milestones(run({ status: "done", stages: merged })).find((m) => m.key.endsWith(":done"))!;
    expect(done.actions.slice(0, 2)).toEqual([{ kind: "unreact", name: "eyes" }, { kind: "react", name: "white_check_mark" }]);
    expect((done.actions[2] as { text: string }).text).toBe("Done (bp-1): merged; the finding closes in Aikido after the deploy and its rescan.");
    const noFix = milestones(run({ status: "done", stages: { investigate: stage({ verdict: "no_code_change", summary: "not reachable" }) } })).find((m) => m.key.endsWith(":done"))!;
    expect((noFix.actions[2] as { text: string }).text).toBe("Done (bp-1): no code change needed.");
  });

  it("sends each milestone once per thread, only for allowed channels, and retries a failure", async () => {
    const calls: string[] = [];
    let fail = true;
    const api = {
      configured: () => true,
      run: async (_c: string, _t: string, a: SlackAction) => {
        if (a.kind === "reply" && fail) {
          fail = false;
          throw new Error("rate limited");
        }
        calls.push(a.kind === "reply" ? "reply" : `${a.kind}:${a.name}`);
      },
    };
    const n = new SlackNotifier(path.join(mkdtempSync(path.join(tmpdir(), "slack-")), "slack.json"), api);
    const r = run({ stages: { investigate: stage({ verdict: "no_code_change", summary: "not reachable" }) } });
    expect(await n.tick([r], [])).toEqual([]); // no channel allowed: nothing
    expect((await n.tick([r], ["C098F6E0AD6"])).length).toBe(1); // 👀; the reply failed
    expect((await n.tick([r], ["C098F6E0AD6"])).length).toBe(1); // the reply, retried
    expect(await n.tick([r, { ...r, id: "bp-2" } as Run], ["C098F6E0AD6"])).toEqual([]); // a child run in the same thread: nothing again
    expect(calls).toEqual(["react:eyes", "reply"]);
  });

  it("calls the Slack Web API with the bot token, in the thread, and takes benign answers as done", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slack-"));
    writeFileSync(path.join(dir, "token"), "xoxb-1\n");
    const sent: { url: string; body: any }[] = [];
    let answer: object = { ok: true };
    const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      expect(init.headers.authorization).toBe("Bearer xoxb-1");
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(answer));
    }) as unknown as typeof fetch;
    const api = slackApi(() => path.join(dir, "token"), fetchImpl);
    await api.run("C1234567", "1.2", { kind: "reply", text: "hi" });
    expect(sent[0]).toMatchObject({ url: "https://slack.com/api/chat.postMessage", body: { channel: "C1234567", thread_ts: "1.2", text: "hi", unfurl_links: false } });
    answer = { ok: false, error: "already_reacted" };
    await api.run("C1234567", "1.2", { kind: "react", name: "eyes" });
    expect(sent[1]).toMatchObject({ url: "https://slack.com/api/reactions.add", body: { timestamp: "1.2", name: "eyes" } });
    answer = { ok: false, error: "missing_scope", needed: "reactions:write" };
    await expect(api.run("C1234567", "1.2", { kind: "unreact", name: "eyes" })).rejects.toThrow(/reactions:write/);
    expect(slackApi(() => path.join(dir, "none")).configured()).toBe(false);
  });
});
