import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { NoteRow } from "./client/note";
import { WardenScreen } from "./client/screen";
import { commandRpc } from "./shared/rpc";

function WardenItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ShieldCheck"
      active={currentScreen?.screenId === "warden"}
      onPress={() => openScreen({ screenId: "warden" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "warden", title: "Agents Warden", Component: WardenScreen });
  client.addSidebarHeaderItem({ id: "warden", title: "Agents Warden", Component: WardenItem });
  const command = {
    argumentHint: "<task> [--interval <minutes>] | stop | supervise [stop]",
    context: "agent" as const,
    async onSubmit({ args, agent, rpc }: { args: string; agent: { id: string }; rpc: any }) {
      await rpc(commandRpc, { agentId: agent.id, args });
    },
  };
  client.addSlashCommand({ ...command, name: "warden", description: "Watch this agent: /warden <task>, stop, supervise, or no args for status" });
  client.addSlashCommand({ ...command, name: "warder", description: "Deprecated alias of /warden" });
  const note = { version: 1, schema: z.object({ text: z.string() }), Component: NoteRow };
  client.addTimelineRenderer({ kind: "warden-note", ...note });
  client.addTimelineRenderer({ kind: "warder-note", ...note }); // notes written before the rename
  return () => {};
}
