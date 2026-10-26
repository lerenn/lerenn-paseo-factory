import type { FactoryHost, Issue } from "../host";
import { resolveAgentConfig } from "../spawn-config";
import { supervisorRpcs } from "./rpcs";
import { Supervisor, SUPERVISOR_LABEL, type SupervisorPorts } from "./manager";
import { SupervisorState } from "./state";
import { INSTRUCTIONS, supervisorTools, TOOL_NAMES_OPEN, TOOL_NAMES_SUPERVISOR } from "./tools";
import { supervisorSettings, type SupervisorSettings } from "../../shared/supervisor/settings";
import { settingsSchema } from "../../shared/supervisor/settings";
import { setWorkspaceTitle, workspaceTitle } from "../workspace-title";

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
      const handle = await host.paseo.agents.create({
        idempotencyKey,
        config: resolveAgentConfig(role, current.defaultProvider),
        cwd,
        title: "Factory Supervisor",
        prompt,
        labels: { "paseo.factory": "1", [SUPERVISOR_LABEL]: "1", "paseo.factory.role": current.role },
        // No kube template: it runs on the daemon, not in a pod.
        env: { PASEO_AGENT_ROLE: current.role, PASEO_WARDEN: "on", PASEO_FACTORY_BLUEPRINTS: "on" },
      });
      await setWorkspaceTitle(host.paseo, handle.id, workspaceTitle(current.role));
      return handle.id;
    },
    async send(agentId, text) {
      await host.paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    async agentState(agentId) {
      try {
        const found = await host.paseo.agents.ref(agentId).refresh();
        if (!found || found.agent.archivedAt) return "gone";
        return found.agent.status === "running" || found.agent.status === "initializing" ? "running" : found.agent.status === "closed" ? "gone" : "idle";
      } catch {
        return "gone";
      }
    },
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
        if (current.autoStart && !started) {
          started = true;
          await supervisor.ensure();
        }
        await supervisor.digest();
        if (current.autoStart) await supervisor.ensure();
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
