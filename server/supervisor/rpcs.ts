import type { FactoryHost } from "../host";
import { supervisorSendRpc, supervisorStartRpc, supervisorStatusRpc } from "../../shared/supervisor/rpc";
import type { SupervisorSettings } from "../../shared/supervisor/settings";
import type { Supervisor } from "./manager";

/** The Supervisor tab's calls. Returns a cleanup (RPC handlers cannot be removed, so it is a no-op kept for symmetry). */
export function supervisorRpcs(host: FactoryHost, supervisor: Supervisor, settings: () => SupervisorSettings | null): () => void {
  host.server.handle(supervisorStatusRpc, async (_input, ctx) => {
    host.capture(ctx);
    return { status: await supervisor.status(), settings: settings() };
  });
  host.server.handle(supervisorStartRpc, async ({ restart }, ctx) => {
    host.capture(ctx);
    await supervisor.ensure({ restart });
    const status = await supervisor.status();
    return { ok: status.state !== "error" && status.agentId !== null, message: supervisor.error };
  });
  host.server.handle(supervisorSendRpc, async ({ text }, ctx) => {
    host.capture(ctx);
    const id = supervisor.state.data.agentId;
    if (!id) return { ok: false, message: "The Supervisor is not running; start it first." };
    try {
      await host.paseo.agents.ref(id).send(`Message from Louis (Supervisor tab): ${text}`, { activeTurnBehavior: "steer" });
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
  return () => undefined;
}
