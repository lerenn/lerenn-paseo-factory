import { useRpc, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { hostBadgeComponent } from "./client/host-badge";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { LeasesScreen } from "./client/screen";
import { countRpc } from "./shared/rpc";

const HostBadge = hostBadgeComponent();

function LeasesItem({ currentScreen, openScreen, theme, host }: PluginSidebarItemProps) {
  const count = useRpc(countRpc);
  const query = useQuery({ queryKey: ["leases", "count"], queryFn: () => count({}), refetchInterval: 10_000 });
  const waiting = query.data?.waiting ?? 0;
  return (
    <SidebarRow
      // `subtitle` is newer than the pinned plugin types, hence the spread.
      {...(HostBadge ? { subtitle: <HostBadge hostId={host.id} /> } : {})}
      icon="Lock"
      active={currentScreen?.screenId === "leases"}
      onPress={() => openScreen({ screenId: "leases" })}
      trailing={
        waiting > 0 ? (
          <View
            accessibilityLabel={`${waiting} waiting`}
            style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accent }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "700" }}>{waiting > 99 ? "99+" : waiting}</Text>
          </View>
        ) : undefined
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "leases", title: "Agents Leases", Component: LeasesScreen });
  client.addSidebarHeaderItem({ id: "leases", title: "Agents Leases", Component: LeasesItem });
  return () => {};
}
