// Wiring of the usage-limit feature into the Blueprints module: the controller, its tools, its RPCs and the probe agent.
import { tmpdir } from "node:os";
import { z } from "zod";
import type { FactoryHost } from "../../host";
import type { CallContext, HostTool } from "../../tools";
import { UsageError } from "../../tools";
import { isTrusted } from "../../trust";
import { spawnAgent } from "../../spawn-agent";
import type { Engine } from "../engine";
import type { RunStore } from "../store";
import type { BlueprintsSettings } from "../../../shared/blueprints/settings";
import { usageLimitAuditRpc, usageLimitLiftRpc, usageLimitStatusRpc } from "../../../shared/blueprints/usage-limit";
import { UsageLimitFile, UsageLimits } from "./controller";

/** Read-only, for every agent (an outside sweep, a heartbeat). */
export const USAGE_LIMIT_OPEN_TOOLS = ["usage_limit_status", "usage_limit_classify"];
export const USAGE_LIMIT_TOOLS = [...USAGE_LIMIT_OPEN_TOOLS, "usage_limit_lift"];
const PROBE_LABEL = "paseo.factory.usage-probe";
const PROBE_TIMEOUT_MS = 180_000;

export const USAGE_LIMIT_NOTE =
  "Factory usage limits: usage_limit_status says whether the Factory is paused for a provider usage limit (paused, resume_at, held runs and agents); usage_limit_classify(message, code?) says whether an error is one.";

interface Deps {
  host: FactoryHost;
  engine: Engine;
  store: RunStore;
  cfg: () => BlueprintsSettings;
  stateFile: string | null;
}

export function startUsageLimits({ host, engine, store, cfg, stateFile }: Deps) {
  const settings = () => cfg().usageLimit ?? { enabled: false, notify: [], unknownAlertTo: "", confirmMinutes: 15, probeMinutes: 5, probeModel: "", resumeConcurrency: 2, resumeStaggerSeconds: 60, resetZone: "UTC" };
  const probes = new Map<string, (o: { kind: "completed" | "failed" | "canceled"; message?: string; code?: string }) => void>();

  const controller = new UsageLimits(new UsageLimitFile(stateFile), {
    now: Date.now,
    settings,
    runs: () => store.all(),
    factorySuspended: () => !!store.suspended(),
    suspend: (runId, input) => engine.suspend(runId, input),
    unsuspend: (runId, input) => engine.unsuspend(runId, input),
    async report(to, r) {
      if (to.trim().toLowerCase() === "supervisor") {
        const sup = host.engines.supervisor as { status(): Promise<{ agentId: string | null }> } | undefined;
        const id = sup ? (await sup.status()).agentId : null;
        if (!id) return; // archived: it reads usage_limit_status when it next wakes
        return host.report(id, r);
      }
      return host.report(to, r);
    },
    async probe(provider) {
      const fallback = cfg().defaultProvider;
      const model = settings().probeModel?.trim() || (provider && provider !== fallback.split("/")[0] ? provider : fallback);
      const { agentId } = await spawnAgent(host.paseo, "local", {
        idempotencyKey: `usage-probe:${Date.now()}`,
        config: { provider: model },
        cwd: cfg().defaultCwd ?? tmpdir(),
        title: "Factory usage-limit probe",
        workspaceTitle: "Usage-limit probe",
        prompt: "Reply with the single word OK and nothing else.",
        labels: { [PROBE_LABEL]: "1" },
        env: { PASEO_WARDEN: "off", PASEO_INBOX: "off", PASEO_LEASES: "off", PASEO_SUPERVISOR: "off", PASEO_USAGE_LIMIT: "off" },
      });
      try {
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            probes.delete(agentId);
            resolve(null);
          }, PROBE_TIMEOUT_MS);
          probes.set(agentId, (o) => {
            clearTimeout(timer);
            probes.delete(agentId);
            resolve(o);
          });
        });
      } finally {
        await host.paseo.agents
          .ref(agentId)
          .archive()
          .catch((error: Error) => console.error(`usage-limit: archiving probe ${agentId} failed`, error));
      }
    },
    log: (line) => console.log(`blueprints: ${line}`),
  });
  engine.usageLimits = controller;

  /** The probe agent ended its turn. */
  const probeEnded = (agentId: string, outcome: { kind: "completed" | "failed" | "canceled"; message?: string; code?: string }) => probes.get(agentId)?.(outcome);

  const tools: Omit<HostTool, "owner">[] = [
    {
      name: "usage_limit_status",
      description:
        "Whether the Factory is held for a provider usage limit: state (clear | run_holds | paused), since, resume_at, provider, rule, the held runs and their workers' agent ids. A heartbeat can read it when a pause or resume mail was missed.",
      input: z.object({}),
      readOnly: true,
      run() {
        const s = controller.status();
        return { ...s, since: s.since ? new Date(s.since).toISOString() : null, resume_at: s.resumeAt ? new Date(s.resumeAt).toISOString() : null };
      },
    },
    {
      name: "usage_limit_classify",
      description:
        "Classify the terminal error of an agent's failed turn: usage_limit (with rule and reset time) or other. Strict: explicit usage-limit signals only (code rate_limit_error / usage_limit_reached, HTTP 429, the provider's own \"usage limit reached\" sentence); 529 overloaded, 5xx, network, auth, context and tool errors are not.",
      input: z.object({ message: z.string().max(4000), code: z.string().max(100).optional(), status: z.number().int().optional() }),
      readOnly: true,
      run({ message, code, status }) {
        const c = controller.classify({ message, code: code ?? null, status: status ?? null });
        return c.kind === "usage_limit" ? { ...c, reset_at: c.resetAt ? new Date(c.resetAt).toISOString() : null } : c;
      },
    },
    {
      name: "usage_limit_lift",
      description: "Lift the Factory's usage-limit pause now (trusted agents and the Supervisor): held runs resume in staggered batches without a probe first.",
      input: z.object({}),
      async run(_input, ctx: CallContext) {
        const labels = await ctx.labels();
        if (!(isTrusted(labels) || labels["paseo.factory.supervisor"] === "1")) throw new UsageError("usage_limit_lift is for an agent with a trusted label and the Supervisor.");
        return controller.lift(ctx.callerId);
      },
    },
  ];
  const removeTools = host.registerTools("blueprints", tools);
  host.contribute({
    module: "blueprints",
    note: USAGE_LIMIT_NOTE,
    tools: (request) => (settings().enabled && request.env?.PASEO_USAGE_LIMIT?.toLowerCase() !== "off" ? USAGE_LIMIT_OPEN_TOOLS : null),
  });

  const { server } = host;
  server.handle(usageLimitStatusRpc, (_input, ctx) => {
    host.capture(ctx);
    return controller.status();
  });
  server.handle(usageLimitAuditRpc, ({ limit }, ctx) => {
    host.capture(ctx);
    return { entries: controller.auditLog(limit) };
  });
  server.handle(usageLimitLiftRpc, ({ by }, ctx) => {
    host.capture(ctx);
    const out = controller.lift(by || "user");
    return { ok: out.ok, message: out.message };
  });

  return { controller, probeEnded, isProbe: (agentId: string) => probes.has(agentId), remove: removeTools };
}
