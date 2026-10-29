import type { Observer, Ports, RunEvent } from "./engine";
import { DEFAULT_RETRO_PROMPT } from "../../shared/blueprints/settings";
import { buildDigest, isTrivial, trivialMail } from "./digest";
import type { JanitorPlan, JanitorTarget, PostState, Run, RunStore } from "./store";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The retro prompt template with its placeholders filled in one pass (a digest that contains `{{...}}` stays as it is). */
export function retroPrompt(template: string, run: Run, to: string, digest: string): string {
  const values: Record<string, string> = { run_id: run.id, mail_to: to, digest };
  return template.replace(/\{\{(run_id|mail_to|digest)\}\}/g, (_m, key: string) => values[key]);
}

/**
 * Everything the Factory does around a run without being a stage of it:
 * event mails while it runs, and after it ends the retro (a small separate agent), then the janitor.
 */
export class PostRun implements Observer {
  private readonly busy = new Set<string>();

  constructor(
    private readonly store: RunStore,
    private readonly ports: Ports,
  ) {}

  private settings() {
    return this.ports.post?.() ?? { eventsMailTo: "", retro: { enabled: false, mailTo: "", role: "retro", maxUsd: 0.3, timeoutMinutes: 10, skipTrivial: true }, janitor: { enabled: false, dryRun: true } };
  }

  private post(run: Run): PostState {
    return (run.post ??= { mailed: [], phase: "new" });
  }

  private mail(to: string, subject: string, body: string, kind: string): void {
    if (!to || !this.ports.report) return;
    void this.ports.report(to, { subject: clip(subject, 200), body, kind }).catch((e) => console.error("blueprints: mail failed", e));
  }

  // ---- event mails ----

  event(run: Run, e: RunEvent): void {
    const to = this.settings().eventsMailTo;
    if (!to) return;
    if (run.parent && e.kind === "failed") return; // the parent run reports its own failure
    const post = this.post(run);
    if (post.mailed.includes(e.key)) return;
    post.mailed.push(e.key);
    if (post.mailed.length > 100) post.mailed.splice(0, post.mailed.length - 100);
    this.store.save();
    const label = run.vars.ticket || run.vars.incident_id || run.blueprint;
    this.mail(to, `Factory ${run.id} ${e.kind}${e.stage ? ` · ${e.stage}` : ""}`, `Run ${run.id} (${run.blueprint} ${label}) is ${e.kind === "waiting" ? "waiting" : e.kind}.\nStage: ${e.stage ?? "?"}\nReason: ${clip(e.reason.replace(/\s+/g, " "), 300)}`, "run");
  }

  /** Lease and extension notices while the Supervisor is disabled: one short mail, never blocking. */
  notice(subject: string, body: string): void {
    this.mail(this.settings().eventsMailTo, subject, body, "info");
  }

  // ---- after the run ----

  finished(run: Run): void {
    void this.drive(run).catch((e) => console.error(`blueprints: post-run of ${run.id} failed`, e));
  }

  /** The retro agent ended its turn. */
  retroEnded(agentId: string): void {
    const run = this.store.all().find((r) => r.post?.phase === "retro" && r.post.retro?.agentId === agentId);
    if (!run) return;
    this.noteSpend(run, agentId);
    run.post!.phase = "archive";
    this.store.save();
    this.finished(run);
  }

  /** Poll: restart recovery, and a retro that never ended. */
  tick(): void {
    const now = this.ports.now();
    for (const run of this.store.all()) {
      if (run.endedAt === null || !run.post || run.post.phase === "done") continue;
      if (now - run.endedAt > 24 * 3600_000) {
        run.post.phase = "done";
        continue;
      }
      this.finished(run);
    }
  }

  private noteSpend(run: Run, agentId: string): void {
    const cost = this.ports.spendOfAgent?.(agentId);
    const max = this.settings().retro.maxUsd;
    if (cost !== undefined && max > 0 && cost > max) this.store.log(run, "retro_over_budget", "retro", `$${cost.toFixed(2)} > $${max.toFixed(2)}`, this.ports.now());
  }

  private async drive(run: Run): Promise<void> {
    if (this.busy.has(run.id)) return;
    this.busy.add(run.id);
    try {
      const post = this.post(run);
      if (post.phase === "new") await this.begin(run, post);
      if (post.phase === "retro") await this.waitRetro(run, post);
      if (post.phase === "archive") await this.archive(run, post);
    } finally {
      this.busy.delete(run.id);
    }
  }

  private async begin(run: Run, post: PostState): Promise<void> {
    const s = this.settings();
    if (s.janitor.enabled) {
      post.plan = await this.plan(run, s.janitor.dryRun).catch((e) => {
        console.error("blueprints: janitor plan failed", e);
        return null;
      });
    }
    this.store.save();
    const janitor = this.janitorLines(run, post.plan ?? null);
    const now = this.ports.now();
    if (!s.retro.enabled || !s.retro.mailTo.trim()) {
      if (janitor.length && s.retro.mailTo) this.mail(s.retro.mailTo, `Factory janitor ${run.id}`, `Run ${run.id} (${run.blueprint}):\n${janitor.join("\n")}`, "info");
      post.phase = "archive";
      return;
    }
    if (s.retro.skipTrivial && isTrivial(run)) {
      const m = trivialMail(run, { now, janitor });
      this.mail(s.retro.mailTo, m.subject, m.body, "info");
      post.phase = "archive";
      this.store.save();
      return;
    }
    const digest = buildDigest(run, { now, spend: this.ports.spend?.(run.id) ?? null, janitor });
    try {
      const { agentId, workspaceId } = await this.ports.spawn({
        idempotencyKey: `${run.id}:retro`,
        role: s.retro.role,
        prompt: retroPrompt(s.retro.prompt ?? DEFAULT_RETRO_PROMPT, run, s.retro.mailTo, digest),
        title: `Retro ${run.blueprint} ${run.id}`,
        workspaceTitle: `Retro: ${run.blueprint} ${run.id}`,
        cwd: this.ports.settings().defaultCwd,
        labels: { "paseo.factory": "1", "paseo.factory.blueprint": run.blueprint, "paseo.factory.run": run.id, "paseo.factory.role": s.retro.role, "paseo.factory.stage": "retro" },
        env: { PASEO_AGENT_ROLE: s.retro.role, PASEO_FACTORY_RUN: run.id, PASEO_FACTORY_STAGE: "retro" },
        // Always a pod: a retro in the daemon adds load to the host every run ends on (decision e833ea19).
        runtime: "kubernetes",
      });
      (run.agents ??= {})[agentId] = { role: s.retro.role, stage: "retro", workspaceId: workspaceId ?? null };
      post.retro = { agentId, startedAt: now };
      post.phase = "retro";
    } catch (error) {
      // No retro agent (no role, no pod: "Daemon client closed"...): the facts still reach the human, unsummarised.
      console.error("blueprints: retro agent failed", error);
      this.mail(s.retro.mailTo, `Factory retro ${run.id} (no agent: ${clip((error as Error).message, 80)})`, clip(digest, 3500), "info");
      post.phase = "archive";
    }
    this.store.save();
  }

  private async waitRetro(run: Run, post: PostState): Promise<void> {
    const s = this.settings();
    const retro = post.retro;
    const waited = this.ports.now() - (retro?.startedAt ?? 0);
    const gone = retro?.agentId ? (await this.ports.agentState(retro.agentId)) === "gone" : true;
    if (gone || waited > s.retro.timeoutMinutes * 60_000) {
      if (!gone) this.store.log(run, "retro_timeout", "retro", `${Math.round(waited / 60_000)} min`, this.ports.now());
      post.phase = "archive";
      this.store.save();
    }
  }

  // ---- janitor ----

  /** Inspect only: which workspaces go (all of them, dirty or not: human rule 2026-10-28). Nothing is archived here. */
  async plan(run: Run, dryRun: boolean): Promise<JanitorPlan> {
    const byWorkspace = new Map<string | null, string[]>();
    for (const [agentId, a] of Object.entries(run.agents ?? {})) {
      if (a.stage === "retro") continue;
      byWorkspace.set(a.workspaceId, [...(byWorkspace.get(a.workspaceId) ?? []), agentId]);
    }
    const plan: JanitorPlan = { archive: [], keep: [], dryRun };
    for (const [workspaceId, agentIds] of byWorkspace) {
      const target: JanitorTarget = { workspaceId, agentIds };
      if (workspaceId && this.ports.trace) {
        const trace = await this.ports.trace(workspaceId).catch(() => "no answer");
        if (trace !== "clean") this.store.log(run, "janitor_trace", null, `${workspaceId}: ${clip(trace, 200)}`, this.ports.now());
      }
      plan.archive.push(target);
    }
    return plan;
  }

  private janitorLines(run: Run, plan: JanitorPlan | null): string[] {
    if (!plan) return [];
    const roles = (t: JanitorTarget) => [...new Set(t.agentIds.map((id) => run.agents?.[id]?.role ?? "?"))].join("+");
    const out: string[] = [];
    if (plan.archive.length) out.push(`${plan.dryRun ? "dry run, would archive" : "archiving"} ${plan.archive.map((t) => `${roles(t)}${t.workspaceId ? ` (workspace ${t.workspaceId})` : ""}`).join(", ")}`);
    for (const k of plan.keep) out.push(`KEPT ${roles(k)} workspace ${k.workspaceId}: ${k.why}`);
    return out;
  }

  private async archive(run: Run, post: PostState): Promise<void> {
    const done = new Set(post.archived ?? []);
    const attempt = async (key: string, fn: () => Promise<void>) => {
      if (done.has(key)) return;
      try {
        await fn();
        done.add(key);
      } catch (error) {
        console.error(`blueprints: janitor ${key} failed`, error);
        this.store.log(run, "janitor_failed", null, `${key}: ${clip((error as Error).message, 160)}`, this.ports.now());
      }
    };
    const archiveTarget = async (t: JanitorTarget) => {
      for (const id of t.agentIds) await attempt(`agent:${id}`, () => this.ports.archive(id));
      if (t.workspaceId && this.ports.archiveWorkspace) {
        const ws = t.workspaceId;
        await attempt(`workspace:${ws}`, () => this.ports.archiveWorkspace!(ws));
      }
    };
    const plan = post.plan;
    if (plan && !plan.dryRun) for (const t of plan.archive) await archiveTarget(t);
    // The retro agent is the Factory's own helper: it goes whatever the janitor decided about the workers.
    if (post.retro?.agentId) await archiveTarget({ workspaceId: run.agents?.[post.retro.agentId]?.workspaceId ?? null, agentIds: [post.retro.agentId] });
    post.archived = [...done];
    post.phase = "done";
    this.store.save();
  }
}
