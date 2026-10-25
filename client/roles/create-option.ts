import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NO_ROLE_VALUE, ROLE_OPTION_ID } from "../../shared/roles/role";
import { listRolesRpc, type RoleEntry } from "../../shared/roles/rpc";

/** How often the picker re-reads the roles, so a synced git source shows up without a reload. */
export const ROLE_REFRESH_MS = 30_000;

// `addCreateOption` needs a host that has create options; older hosts do not have it.
interface CreateOptionClient {
  addCreateOption?(contribution: {
    id: string;
    label: string;
    icon: string;
    options: ReadonlyArray<{ value: string; label: string; description?: string }>;
    defaultValue: string;
  }): () => void;
}

export function roleOptions(entries: readonly RoleEntry[]) {
  return [
    { value: NO_ROLE_VALUE, label: "No role" },
    ...entries
      .filter((entry) => entry.role && !entry.error)
      .map((entry) => ({
        value: entry.name,
        label: entry.name,
        ...(entry.role?.description ? { description: entry.role.description } : {}),
      })),
  ];
}

/**
 * Offers the roles on the New workspace and new-agent composers. The option list is static per
 * registration, so it is registered again whenever the roles change.
 */
export function registerRoleCreateOption(client: PluginClientContext): () => void {
  const host = client as PluginClientContext & CreateOptionClient;
  if (typeof host.addCreateOption !== "function") return () => {};
  let remove = () => {};
  let shown = "";
  let stopped = false;

  async function refresh() {
    let options: ReturnType<typeof roleOptions>;
    try {
      options = roleOptions((await client.rpc(listRolesRpc, {})).roles);
    } catch {
      return;
    }
    const next = JSON.stringify(options);
    if (stopped || next === shown) return;
    shown = next;
    remove();
    // With no valid role there is nothing to pick; "No role" alone would be a dead control.
    remove =
      options.length > 1
        ? host.addCreateOption!({
            id: ROLE_OPTION_ID,
            label: "Role",
            icon: "UserCog",
            options,
            defaultValue: NO_ROLE_VALUE,
          })
        : () => {};
  }

  void refresh();
  const timer = setInterval(() => void refresh(), ROLE_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    remove();
  };
}
