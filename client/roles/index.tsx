import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerRoleCreateOption } from "./create-option";

export { RolesScreen } from "./screen";

/** Roles has no sidebar row or screen of its own: the Factory shows it as a tab. */
export function contributeRoles(client: PluginClientContext) {
  return registerRoleCreateOption(client);
}
