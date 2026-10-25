import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerRoleCreateOption } from "./client/create-option";

export { RolesScreen } from "./client/screen";

/** Roles has no sidebar row or screen of its own: the Factory shows it as a tab. */
export function contributeRoles(client: PluginClientContext) {
  return registerRoleCreateOption(client);
}
