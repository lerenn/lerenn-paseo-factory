import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { ROLE_ENV, type Role } from "../../shared/roles/role";

type CreateRequest = PluginBeforeRequests["agent.create"];

export const MCP_SERVERS_ENV = "PASEO_MCP_SERVERS";

/** Replace `${NAME}` in a role env value with the daemon's `NAME`; a missing one fails with a clear message. */
export function resolveEnv(role: Role, daemonEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(role.env ?? {})) {
    out[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const found = daemonEnv[name];
      if (found === undefined || found === "") {
        throw new Error(`Role "${role.name}": env ${key} references \${${name}}, which is not set on the daemon`);
      }
      return found;
    });
  }
  return out;
}

/** Defaults for other plugins, as the environment they already read. */
export function pluginEnv(role: Role): Record<string, string> {
  const p = role.plugins;
  const warder = typeof p?.warder === "string" ? { mode: p.warder, interval: undefined } : p?.warder;
  return {
    ...(p?.kubeTemplate ? { PASEO_KUBE_TEMPLATE: p.kubeTemplate } : {}),
    ...(warder?.mode ? { PASEO_WARDER: warder.mode } : {}),
    ...(warder?.interval ? { PASEO_WARDER_INTERVAL: warder.interval } : {}),
    ...(p?.ticket ? { PASEO_AGENT_TICKET: p.ticket } : {}),
  };
}

/** Rewrite an agent.create request so the agent starts as `role`. */
export function applyRole(
  request: CreateRequest,
  role: Role,
  daemonEnv: Record<string, string | undefined> = process.env,
): CreateRequest {
  const config = { ...request.config };
  if (role.provider) config.provider = role.provider;
  if (role.model) config.model = role.model;
  if (role.modeId) config.modeId = role.modeId;
  if (role.thinkingOptionId) config.thinkingOptionId = role.thinkingOptionId;
  if (role.systemPrompt) {
    config.systemPrompt = [role.systemPrompt, request.config.systemPrompt]
      .filter(Boolean)
      .join("\n\n");
  }
  if (role.preapprovedTools?.length) {
    config.toolPolicy = {
      preapproved: [
        ...(request.config.toolPolicy?.preapproved ?? []),
        ...role.preapprovedTools.map((t) => ({ kind: "mcp" as const, ...t })),
      ],
    };
  }
  if (role.providerOptions) {
    config.providerOptions = { ...request.config.providerOptions, ...role.providerOptions };
  }
  const mcp: Record<string, string> = role.mcpServers?.length ? { [MCP_SERVERS_ENV]: role.mcpServers.join(",") } : {};
  // Lowest to highest: plugin defaults, MCP names, role env, then what the creator passed.
  return {
    config,
    env: { ...pluginEnv(role), ...mcp, ...resolveEnv(role, daemonEnv), ...request.env, [ROLE_ENV]: role.name },
  };
}
