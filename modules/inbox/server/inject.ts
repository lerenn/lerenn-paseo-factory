import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

type CreateRequest = PluginBeforeRequests["agent.create"];

export const SERVER_NAME = "inbox";
export const SCOPE_ENV = "PASEO_INBOX";
export const CAPABILITY_ENV = "PASEO_INBOX_CAPABILITY";
export const TOOL_NAMES = ["inbox_ask", "inbox_status", "inbox_list", "inbox_withdraw"];

export function scopeApplies(scope: "all" | "opt-in", env: Record<string, string> | undefined): boolean {
  const value = env?.[SCOPE_ENV]?.toLowerCase();
  if (value === "off") return false;
  return scope === "all" || value === "on";
}

const NOTE =
  "Agents Inbox: when you need a human decision, an approval, or information only the user has, call inbox_ask " +
  "(blocking by default), then end your turn. The answer arrives as a message starting with \"Agents Inbox:\". " +
  "Do not guess or proceed on risky steps while a blocking question is pending.";

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
