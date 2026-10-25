import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text } from "react-native";
import { GitSourcesPanel, makeStyles } from "./roles/screen";
import { listRolesRpc, syncSourcesRpc } from "../shared/roles/rpc";

/** The Factory's one git sync (roles/, blueprints/, ...): sources, "Sync now", status and errors. */
export function GitSourcesSection({ theme, layout }: Pick<PluginScreenProps, "theme" | "layout">) {
  const queryClient = useQueryClient();
  const listRoles = useRpc(listRolesRpc);
  const syncSources = useRpc(syncSourcesRpc);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const roles = useQuery({ queryKey: ["agents-roles", "roles"], queryFn: () => listRoles({}), refetchInterval: 15_000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agents-roles"] });
  const sync = useMutation({ mutationFn: () => syncSources({}), onSuccess: refresh });
  return (
    <>
      {roles.error ? <Text style={styles.error}>{String(roles.error)}</Text> : null}
      <GitSourcesPanel
        styles={styles}
        open
        alwaysOpen
        onToggle={() => undefined}
        statuses={roles.data?.git ?? []}
        syncing={sync.isPending}
        onSync={() => sync.mutate()}
        onSaved={refresh}
      />
    </>
  );
}
