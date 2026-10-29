// Slack feedback in an alert's thread (human decision f36893f5): a run started from a Slack message carries `slack_channel` and
// `slack_thread_ts` (handed on to its child runs). From the run's state, once each per thread: 👀 on the alert, the diagnosis when
// the investigation ends, the pull request links when they are open, ✅ instead of 👀 once merged, and a closing reply (with ✅) when the alert's own run is done. Only channels on the
// allowlist, only the bot's own reactions, replies only in the thread, and the text is escaped so it can mention nobody.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Run } from "./store";

export type SlackAction =
  | { kind: "react"; name: string }
  | { kind: "unreact"; name: string }
  | { kind: "reply"; text: string };

export interface Milestone {
  /** Per thread: `<channel>:<thread_ts>:<what>`. */
  key: string;
  channel: string;
  thread: string;
  actions: SlackAction[];
}

const VERDICT: Record<string, string> = {
  fix_needed: "a code fix is needed; the Factory is on it",
  no_code_change: "no code change needed",
  human_input_required: "a person has to decide",
};

/** Slack-safe text: no mentions or links can be formed by `<`, `>` or `&`, and it fits in a message. */
export function slackEscape(text: string, max = 2900): string {
  const clean = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** What the run has reached that its alert thread should hear about. Pure. */
export function milestones(run: Run): Milestone[] {
  const channel = run.vars.slack_channel?.trim();
  const thread = run.vars.slack_thread_ts?.trim();
  if (!channel || !thread) return [];
  const base = `${channel}:${thread}`;
  const out: Milestone[] = [{ key: `${base}:seen`, channel, thread, actions: [{ kind: "react", name: "eyes" }] }];
  const inv = run.stages.investigate;
  if (inv?.status === "done" && inv.verdict) {
    const label = VERDICT[inv.verdict] ?? inv.verdict;
    out.push({ key: `${base}:diagnosis`, channel, thread, actions: [{ kind: "reply", text: `Diagnosis: ${label}.\n${slackEscape(inv.summary ?? "", 2500)}` }] });
  }
  for (const st of Object.values(run.stages)) {
    const urls = Array.isArray(st.data?.pr_urls) ? (st.data.pr_urls as unknown[]).filter((u): u is string => typeof u === "string" && /^https:\/\/github\.com\//.test(u)) : [];
    if (st.status !== "done" || !urls.length) continue;
    const set = [...new Set(urls)].sort();
    out.push({ key: `${base}:prs:${set.join(",")}`, channel, thread, actions: [{ kind: "reply", text: `Pull request${set.length > 1 ? "s" : ""}:\n${set.map((u) => `• ${u}`).join("\n")}` }] });
  }
  const merged = run.history.some((h) => h.event === "merged") || Object.values(run.stages).some((st) => st.verdict === "merged");
  if (merged) out.push({ key: `${base}:merged`, channel, thread, actions: [{ kind: "unreact", name: "eyes" }, { kind: "react", name: "white_check_mark" }] });
  // The run that the alert started ended well (merged, or no code change needed): ✅ in place of 👀 and a closing reply (decision 7ffd9055).
  if (!run.parent && run.status === "done") {
    const how = merged ? "merged; the finding closes in Aikido after the deploy and its rescan" : inv?.verdict ? (VERDICT[inv.verdict] ?? inv.verdict) : "finished";
    out.push({ key: `${base}:done`, channel, thread, actions: [{ kind: "unreact", name: "eyes" }, { kind: "react", name: "white_check_mark" }, { kind: "reply", text: `Done (${slackEscape(run.id, 40)}): ${how}.` }] });
  }
  return out;
}

/** Slack Web API calls the notifier needs; benign answers (already reacted, no such reaction) count as done. */
export function slackApi(tokenFile: () => string, fetchImpl: typeof fetch = fetch, api = "https://slack.com/api") {
  const token = () => {
    try {
      return readFileSync(tokenFile(), "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  return {
    configured: () => token() !== null,
    async run(channel: string, thread: string, a: SlackAction): Promise<void> {
      const t = token();
      if (!t) throw new Error(`no Slack bot token in ${tokenFile()}`);
      const [method, body] =
        a.kind === "reply"
          ? ["chat.postMessage", { channel, thread_ts: thread, text: a.text, unfurl_links: false, unfurl_media: false }]
          : [a.kind === "react" ? "reactions.add" : "reactions.remove", { channel, timestamp: thread, name: a.name }];
      const res = await fetchImpl(`${api}/${method}`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) as never });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; needed?: string };
      if (j.ok || j.error === "already_reacted" || j.error === "no_reaction") return;
      throw new Error(`Slack ${method}: ${j.error ?? res.status}${j.needed ? ` (needs ${j.needed})` : ""}`);
    },
  };
}

/** Sends each milestone once (persisted), only for allowed channels; a failed one is tried again on the next tick. */
export class SlackNotifier {
  private done: Set<string> | null = null;

  constructor(
    private readonly file: string,
    private readonly api: { configured(): boolean; run(channel: string, thread: string, a: SlackAction): Promise<void> },
  ) {}

  private load(): Set<string> {
    if (this.done) return this.done;
    try {
      this.done = existsSync(this.file) ? new Set(JSON.parse(readFileSync(this.file, "utf8")) as string[]) : new Set();
    } catch {
      this.done = new Set();
    }
    return this.done;
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.done!].slice(-5000)));
    renameSync(tmp, this.file);
  }

  /** Returns the milestones sent this time. */
  async tick(runs: Run[], channels: readonly string[]): Promise<string[]> {
    if (!channels.length || !this.api.configured()) return [];
    const done = this.load();
    const sent: string[] = [];
    for (const run of runs) {
      for (const m of milestones(run)) {
        if (done.has(m.key) || !channels.includes(m.channel)) continue;
        try {
          for (const a of m.actions) await this.api.run(m.channel, m.thread, a);
        } catch (error) {
          console.error(`blueprints: Slack ${m.key} failed: ${(error as Error).message}`);
          continue;
        }
        done.add(m.key);
        sent.push(m.key);
        this.save();
      }
    }
    return sent;
  }
}
