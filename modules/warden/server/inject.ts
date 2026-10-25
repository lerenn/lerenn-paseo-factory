import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

type CreateRequest = PluginBeforeRequests["agent.create"];

export const SERVER_NAME = "warden";
export const SCOPE_ENV = "PASEO_WARDEN";
export const CAPABILITY_ENV = "PASEO_WARDEN_CAPABILITY";
export const TOOL_NAMES = ["warden_register", "warden_register_subagent", "warden_update", "warden_done", "warden_list"];

/** Pre-rename names (the plugin was "warder"): agents created before the rename still hold these. */
export const LEGACY_SERVER_NAME = "warder";
export const LEGACY_SCOPE_ENV = "PASEO_WARDER";
export const LEGACY_TOOL_NAMES = TOOL_NAMES.map((n) => n.replace("warden_", "warder_"));

/** Env value under the current name, else under the deprecated pre-rename name. */
export function envValue(env: Record<string, string | undefined> | undefined, name: string): string | undefined {
  return env?.[name] ?? env?.[name.replace("WARDEN", "WARDER")];
}

export function scopeApplies(scope: "all" | "opt-in", env: Record<string, string> | undefined): boolean {
  const value = envValue(env, SCOPE_ENV)?.toLowerCase();
  if (value === "off") return false;
  return scope === "all" || value === "on";
}

const NOTE =
  "Warden: for long work or anything you wait on (builds, CI, reviews, subagents), call warden_register(task, interval_minutes) so you " +
  "get a prompt if you go quiet. Call warden_update with progress and warden_done when finished. " +
  "If you manage subagents, warden_register_subagent watches one of them.";

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
