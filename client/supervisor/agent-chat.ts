import type { ComponentType } from "react";
import * as ui from "@getpaseo/plugin/client/ui";

type AgentChatComponent = ComponentType<{ agentId: string }>;

/**
 * The app's native agent conversation, or null on an app that predates it (the tab then only offers
 * "Open agent"). Read off the namespace so a missing export is `undefined`, not a load-time error.
 */
export function agentChatComponent(uiModule: object = ui): AgentChatComponent | null {
  const chat = (uiModule as { AgentChat?: AgentChatComponent }).AgentChat;
  return typeof chat === "function" || (typeof chat === "object" && chat !== null) ? chat : null;
}
