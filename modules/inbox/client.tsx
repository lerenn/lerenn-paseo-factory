import { useRpc, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { InboxScreen } from "./client/screen";
import { countRpc } from "./shared/rpc";

function InboxItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const count = useRpc(countRpc);
  const query = useQuery({ queryKey: ["inbox", "count"], queryFn: () => count({}), refetchInterval: 10_000 });
  const unread = query.data?.unread ?? 0;
  return (
    <SidebarRow
      icon="Inbox"
      active={currentScreen?.screenId === "inbox"}
      onPress={() => openScreen({ screenId: "inbox" })}
      trailing={
        unread > 0 ? (
          <View
            accessibilityLabel={`${unread} unread`}
            style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accent }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "700" }}>{unread > 99 ? "99+" : unread}</Text>
          </View>
        ) : undefined
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "inbox", title: "Agents Inbox", Component: InboxScreen });
  client.addSidebarHeaderItem({ id: "inbox", title: "Agents Inbox", Component: InboxItem });
  return () => {};
}
