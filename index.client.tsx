import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { installRegistry } from "./client/registry";
import { FactoryScreen } from "./client/screen";
import { hostBadgeComponent } from "./client/leases/host-badge";
import { useRunsNeedingAttention } from "./client/blueprints";
import { useInboxCount } from "./client/inbox";
import { useLeasesWaiting } from "./client/leases";
import { contributeRoles } from "./client/roles";
import { contributeWarden } from "./client/warden";

const HostBadge = hostBadgeComponent();

function FactoryItem({ currentScreen, openScreen, theme, host }: PluginSidebarItemProps) {
  const total = useInboxCount() + useLeasesWaiting() + useRunsNeedingAttention();
  return (
    <SidebarRow
      // `subtitle` is newer than the pinned plugin types, hence the spread.
      {...(HostBadge ? { subtitle: <HostBadge hostId={host.id} /> } : {})}
      icon="Factory"
      active={currentScreen?.screenId === "factory"}
      onPress={() => openScreen({ screenId: "factory" })}
      trailing={
        total > 0 ? (
          <View
            accessibilityLabel={`${total} need attention`}
            style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accent }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "700" }}>{total > 99 ? "99+" : total}</Text>
          </View>
        ) : undefined
      }
    />
  );
}

/** Agent badges (fork PR lerenn/paseo#36, "Agent badges" in public-docs/plugins/reference.md). Absent on older hosts. */
interface AgentBadgeClient {
  addAgentBadge?(badge: {
    id: string;
    scope?: "agent" | "workspace";
    match: { labels: Record<string, string> };
    render: {
      icon: string;
      text?(agent: { labels: Readonly<Record<string, string>> }): string;
      tooltip?(agent: { labels: Readonly<Record<string, string>> }): string;
    };
  }): () => void;
}

export default function contribute(client: PluginClientContext) {
  installRegistry();
  const cleanups: (() => void | Promise<void>)[] = [];
  cleanups.push(client.addScreen({ id: "factory", title: "Paseo Factory", Component: FactoryScreen }));
  cleanups.push(client.addSidebarHeaderItem({ id: "factory", title: "Paseo Factory", Component: FactoryItem }));
  cleanups.push(contributeRoles(client), contributeWarden(client));

  const badges = client as unknown as AgentBadgeClient;
  if (typeof badges.addAgentBadge === "function") {
    try {
      cleanups.push(
        badges.addAgentBadge({
          id: "factory-run",
          scope: "workspace",
          match: { labels: { "paseo.factory": "*" } },
          render: {
            icon: "Factory",
            text: (a) => `${a.labels["paseo.factory.blueprint"] ?? "factory"} · ${a.labels["paseo.factory.stage"] ?? "?"}`,
            tooltip: (a) => `Factory run ${a.labels["paseo.factory.run"] ?? "?"} · role ${a.labels["paseo.factory.role"] ?? "?"}`,
          },
        }),
      );
    } catch (error) {
      console.error("factory: could not register the agent badge", error);
    }
  }
  return async () => {
    for (const cleanup of cleanups) await cleanup?.();
  };
}
