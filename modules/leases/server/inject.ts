import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

type CreateRequest = PluginBeforeRequests["agent.create"];

export const SERVER_NAME = "leases";
export const SCOPE_ENV = "PASEO_LEASES";
export const CAPABILITY_ENV = "PASEO_LEASES_CAPABILITY";
export const TOOL_NAMES = ["lease_acquire", "lease_renew", "lease_release", "lease_list"];

export function scopeApplies(scope: "all" | "opt-in", env: Record<string, string> | undefined): boolean {
  const value = env?.[SCOPE_ENV]?.toLowerCase();
  if (value === "off") return false;
  return scope === "all" || value === "on";
}

const NOTE =
  "Agents Leases: before working on a resource other agents may touch (a PR, a QA environment, anything shared), take its named lease with lease_acquire. " +
  "Keep the returned token, renew before the TTL ends, release when done. If you are queued, end your turn: a message starting with \"Agents Leases:\" wakes you when it is yours. " +
  "A message saying you lost a lease means stop working on that resource at once.";

export function applyInjection(request: CreateRequest, o: { url: string; capability: string }): CreateRequest {
  const preapproved = request.config.toolPolicy?.preapproved ?? [];
  return {
    ...request,
    config: {
      ...request.config,
      systemPrompt: [request.config.systemPrompt, NOTE].filter(Boolean).join("\n\n"),
      mcpServers: {
        ...request.config.mcpServers,
        [SERVER_NAME]: { type: "http", url: `${o.url}/mcp`, headers: { authorization: `Bearer ${o.capability}` }, alwaysLoad: true },
      },
      toolPolicy: {
        ...request.config.toolPolicy,
        preapproved: [...preapproved, ...TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: SERVER_NAME, tool }))],
      },
    },
    env: { ...request.env, [CAPABILITY_ENV]: o.capability },
  };
}
