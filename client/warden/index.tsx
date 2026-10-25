import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { NoteRow } from "./note";
import { commandRpc } from "../../shared/warden/rpc";

export { WardenScreen } from "./screen";

/** Warden has no sidebar row or screen of its own: the Factory shows it as a tab. */
export function contributeWarden(client: PluginClientContext) {
  const command = {
    argumentHint: "<task> [--interval <minutes>] | stop | supervise [stop]",
    context: "agent" as const,
    async onSubmit({ args, agent, rpc }: { args: string; agent: { id: string }; rpc: any }) {
      await rpc(commandRpc, { agentId: agent.id, args });
    },
  };
  client.addSlashCommand({ ...command, name: "warden", description: "Watch this agent: /warden <task>, stop, supervise, or no args for status" });
  client.addTimelineRenderer({ kind: "warden-note", version: 1, schema: z.object({ text: z.string() }), Component: NoteRow });
  return () => {};
}
