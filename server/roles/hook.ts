import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import { NO_ROLE_VALUE, PLUGIN_ID, ROLE_ENV, ROLE_OPTION_ID } from "../../shared/roles/role";
import { applyRole } from "./apply";
import type { AgentActivity, RoleLimits } from "./limits";
import { loadRole } from "./loader";

// `pluginOptions` needs a host with create options; older SDK typings do not declare it.
type CreateRequest = PluginBeforeRequests["agent.create"] & {
  pluginOptions?: Record<string, Record<string, string>>;
};
type SessionOpen = PluginBeforeRequests["agent.session_open"];

/** Activity of an agent as the daemon sees it: working, idle or finished, or no longer there. */
export async function agentActivity(context: PluginHookContext, agentId: string): Promise<AgentActivity> {
  try {
    const found = await context.paseo.agents.ref(agentId).refresh();
    if (!found || found.agent.archivedAt) return "gone";
    // An agent in error (or closed, or idle) is not working: it holds no place.
    return found.agent.status === "running" || found.agent.status === "initializing" ? "active" : "inactive";
  } catch {
    return "inactive";
  }
}

/** The role picked in the Role picker, else the one named in PASEO_AGENT_ROLE. */
function requestedRole(request: CreateRequest): string | undefined {
  const picked = request.pluginOptions?.[PLUGIN_ID]?.[ROLE_OPTION_ID];
  if (picked && picked !== NO_ROLE_VALUE) return picked;
  return request.env?.[ROLE_ENV];
}

/**
 * The agent.create hook: if the request picks a role (the Role picker) or names one in
 * PASEO_AGENT_ROLE, look it up in the
 * git sources' role folders (`dirs`, in precedence order), enforce its concurrency limit and apply it.
 */
export function agentCreateHook(dirs: () => Promise<string[]>, limits?: RoleLimits, superseded?: (agentId: string) => boolean) {
  return async (
    { request }: { request: CreateRequest },
    context?: PluginHookContext,
  ): Promise<CreateRequest | undefined> => {
    const name = requestedRole(request);
    if (!name) return;
    const folders = await dirs();
    const role = await loadRole(name, folders);
    if (!role) {
      throw new Error(
        folders.length
          ? `${ROLE_ENV}=${name}: no such role in the git sources (looked in ${folders.join(", ")})`
          : `${ROLE_ENV}=${name}: no git source is configured, so there are no roles`,
      );
    }
    const applied = applyRole(request, role);
    if (role.maxConcurrent && limits && context) {
      await limits.reserve(role.name, role.maxConcurrent, (id) => agentActivity(context, id), superseded);
    }
    return applied;
  };
}

/** The agent.session_open hook: learn which agent runs which role, for the concurrency limit. */
export function sessionOpenHook(limits: RoleLimits) {
  return async ({ request }: { request: SessionOpen }): Promise<undefined> => {
    const role = request.env[ROLE_ENV];
    if (role && request.purpose === "interactive") limits.register(request.agentId, role, request.reason === "create");
    return undefined;
  };
}
