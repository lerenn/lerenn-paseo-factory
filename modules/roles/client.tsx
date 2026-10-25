import { type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { registerRoleCreateOption } from "./client/create-option";
import { RolesScreen } from "./client/screen";

function RolesItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      label="Agent Roles"
      icon="UserCog"
      active={currentScreen?.screenId === "roles"}
      onPress={() => openScreen({ screenId: "roles" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "roles", title: "Agent Roles", Component: RolesScreen });
  client.addSidebarHeaderItem({ id: "roles", title: "Agent Roles", Component: RolesItem });
  return registerRoleCreateOption(client);
}
