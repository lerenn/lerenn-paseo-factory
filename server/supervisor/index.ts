import { execFile } from "node:child_process";
import type { FactoryHost, Issue } from "../host";
import { resolveAgentConfig } from "../spawn-config";
import { supervisorRpcs } from "./rpcs";
import { Supervisor, SUPERVISOR_LABEL, type FactoryActivity, type SupervisorPorts } from "./manager";
import { SupervisorState } from "./state";
import { INSTRUCTIONS, supervisorTools, TOOL_NAMES_OPEN, TOOL_NAMES_SUPERVISOR } from "./tools";
import { supervisorSettings, type SupervisorSettings } from "../../shared/supervisor/settings";
import { settingsSchema } from "../../shared/supervisor/settings";
import { workspaceTitle } from "../workspace-title";
import { spawnAgent } from "../spawn-agent";

export function startSupervisor(host: FactoryHost) {
  const { server } = host;
  const settings = server.registerSettings(supervisorSettings);
  let current: SupervisorSettings = settingsSchema.parse({});
  let settingsRead: SupervisorSettings | null = null;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") {
      current = state.values;
      settingsRead = state.values;
    }
  };
  const ready = settings.read().then(apply);
  const unsubscribe = settings.subscribe(apply);

  const ports: SupervisorPorts = {
    now: Date.now,
    async create({ idempotencyKey, prompt, cwd }) {
      const role = await host.loadRole(current.role);
      const { agentId, workspaceId } = await spawnAgent(host.paseo, host.runtime, {
        idempotencyKey,
        config: resolveAgentConfig(role, current.defaultProvider) as never,
        cwd,
        title: "Factory Supervisor",
        workspaceTitle: workspaceTitle(current.role),
        prompt,
        labels: { "paseo.factory": "1", [SUPERVISOR_LABEL]: "1", "paseo.factory.role": current.role },
        env: { PASEO_AGENT_ROLE: current.role, PASEO_WARDEN: "on", PASEO_FACTORY_BLUEPRINTS: "on" },
      });
      return { agentId, workspaceId };
    },
    async send(agentId, text) {
      await host.paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    report: (agentId, report) => host.report(agentId, report),
    async agentState(agentId) {
      try {
        const found = await host.paseo.agents.ref(agentId).refresh();
        if (!found || found.agent.archivedAt) return "gone";
        return found.agent.status === "running" || found.agent.status === "initializing" ? "running" : found.agent.status === "closed" ? "gone" : "idle";
      } catch {
        return "gone";
      }
    },
    async archive(agentId, workspaceId) {
      // The pod of the agent is its workspace: archive both, or the pod leaks. Locally the workspace is the user's checkout, left alone.
      let workspace = workspaceId;
      if (!workspace && host.runtime === "kubernetes") {
        const found = await host.paseo.agents.ref(agentId).refresh().catch(() => null);
        workspace = (found?.agent as { workspaceId?: string | null } | undefined)?.workspaceId ?? null;
      }
      await host.paseo.agents.ref(agentId).archive().catch((error: Error) => {
        if (!/archived|not found|unknown/i.test(error.message)) throw error;
      });
      if (!workspace) return;
      try {
        const result = await host.paseo.workspaces.archive(workspace);
        if (result.error) throw new Error(result.error);
      } catch (error) {
        await new Promise<void>((resolve, reject) => execFile("paseo", ["workspace", "archive", workspace!], { timeout: 60_000 }, (e) => (e ? reject(new Error(`${(error as Error).message}; paseo workspace archive failed: ${e.message}`)) : resolve())));
      }
    },
    async awaitTurn(agentId, ms) {
      const until = Date.now() + ms;
      const started = Date.now();
      let sawRunning = false;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        const state = await ports.agentState(agentId);
        if (state === "gone") return;
        if (state === "running") sawRunning = true;
        else if (sawRunning || Date.now() - started > 15_000) return;
      }
    },
    async factory() {
      const bp = host.engines.blueprints?.store as { active(): import("../blueprints/store").Run[] } | undefined;
      const runs: FactoryActivity["runs"] = [];
      let liveStageAgents = 0;
      for (const run of bp?.active() ?? []) {
        runs.push({ id: run.id, label: `${run.blueprint} ${run.vars.ticket || run.vars.incident_id || run.id}`, status: run.status as "running" | "waiting" | "paused", stage: run.stage, detail: run.error ?? run.waitingFor });
        for (const st of Object.values(run.stages)) if (st.status === "running" && st.agentId && (await ports.agentState(st.agentId)) !== "gone") liveStageAgents += 1;
      }
      return { runs, liveStageAgents };
    },
    flag: (report) => host.report("@assistant", report),
    async issues() {
      const out: Issue[] = [];
      for (const source of host.issueSources) {
        try {
          out.push(...(await source()));
        } catch (error) {
          console.error("supervisor: issue source failed", error);
        }
      }
      return out;
    },
    nameOf: (id) => host.nameOf(id),
    restartExtension: (id) => host.restartExtension(id),
    settings: () => current,
    defaultCwd: () => process.env.FACTORY_DEFAULT_CWD,
  };
  const supervisor = new Supervisor(new SupervisorState(process.env.SUPERVISOR_STATE ?? host.statePath("supervisor")), ports);
  host.engines.supervisor = supervisor;
  // An extension that crashed (dropped as unreachable) wakes the Supervisor through the digest, now rather than at the next tick.
  host.extensionDropped.push(() => void supervisor.digest().catch((error) => console.error("supervisor: digest failed", error)));

  const removeTools = host.registerTools("supervisor", supervisorTools(supervisor));
  host.setInstructions("supervisor", INSTRUCTIONS);
  host.contribute({
    module: "supervisor",
    note: "Factory Supervisor: ask it about the Factory with supervisor_ask(question); supervisor_status gives its agent id.",
    tools: (request) => (request.env?.PASEO_SUPERVISOR?.toLowerCase() === "off" ? null : request.env?.PASEO_AGENT_ROLE === current.role ? [...TOOL_NAMES_OPEN, ...TOOL_NAMES_SUPERVISOR] : TOOL_NAMES_OPEN),
  });
  const removeRpcs = supervisorRpcs(host, supervisor, () => settingsRead);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let started = false;
  const loop = async () => {
    try {
      await ready;
      if (host.enabled("supervisor") && host.hasPaseo()) {
        // Always on (idleArchiveMinutes 0): keep the agent up as before. On demand: it is woken by what needs it.
        if (current.autoStart && current.idleArchiveMinutes === 0 && !started) {
          started = true;
          await supervisor.ensure();
        }
        await supervisor.digest();
        if (current.autoStart && current.idleArchiveMinutes === 0) await supervisor.ensure();
        await supervisor.tick();
      }
    } catch (error) {
      console.error("supervisor: loop failed", error);
    }
    if (!stopped) timer = setTimeout(loop, current.digestSeconds * 1000);
  };
  timer = setTimeout(loop, 20_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    removeTools();
    removeRpcs();
  };
}
