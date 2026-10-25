import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useSyncExternalStore } from "react";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { BlueprintsScreen } from "./blueprints";
import { InboxScreen } from "./inbox";
import { LeasesScreen } from "./leases";
import { RolesScreen } from "./roles";
import { WardenScreen } from "./warden";
import { extensionCallRpc, overviewRpc } from "../shared/rpc";
import { GitSourcesSection } from "./git-sources";
import { subscribeTabs, tabFor } from "./registry";
import { factorySettings, MODULES, type ModuleId } from "../shared/settings";

const TITLES: Record<ModuleId, string> = { blueprints: "Blueprints", roles: "Roles", leases: "Leases", warden: "Warden", inbox: "Inbox" };
const SCREENS = { blueprints: BlueprintsScreen, roles: RolesScreen, leases: LeasesScreen, warden: WardenScreen, inbox: InboxScreen };
const SETTINGS_TAB = "~settings";

function SettingsTab({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(factorySettings);
  const c = theme.colors;
  const pad = layout.compact ? 10 : 20;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: pad, gap: 8 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>Factory settings</Text>
      {settings.status === "ready" ? (
        <SettingsCard>
          {MODULES.map((id) => (
            <SettingsSwitch
              key={id}
              label={TITLES[id]}
              hint="Switched off, the module loses its tab, hooks and MCP tools."
              value={settings.values.modules[id]}
              onValueChange={(on) => void settings.save({ ...settings.values, modules: { ...settings.values.modules, [id]: on } }, settings.revision)}
            />
          ))}
          <SettingsSwitch
            label="Import legacy state once"
            hint="On the next start, a module with no Factory state yet copies the state of its old plugin (leases, warden, inbox). Off by default."
            value={settings.values.importLegacyState}
            onValueChange={(on) => void settings.save({ ...settings.values, importLegacyState: on }, settings.revision)}
          />
          {settings.saveError ? <Text style={{ color: c.statusDanger }}>{settings.saveError}</Text> : null}
        </SettingsCard>
      ) : (
        <Text style={{ color: c.foregroundMuted }}>{settings.status === "loading" ? "Loading…" : `Settings: ${"error" in settings ? settings.error : ""}`}</Text>
      )}
      <GitSourcesSection theme={theme} layout={layout} />
    </ScrollView>
  );
}

function ExtensionTab({ theme, layout, ext }: PluginScreenProps & { ext: { id: string; version: string; tab: string | null; tools: string[]; stageKinds: string[] } }) {
  const c = theme.colors;
  const rpc = useRpc(extensionCallRpc);
  const Component = useSyncExternalStore(subscribeTabs, () => tabFor(ext.id));
  const call = useCallback(
    async (name: string, input?: unknown) => {
      const out = await rpc({ id: ext.id, name, input });
      if (!out.ok) throw new Error(out.error ?? "extension call failed");
      return out.output;
    },
    [rpc, ext.id],
  );
  if (Component) return <Component theme={theme} layout={layout} extensionId={ext.id} call={call} />;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 16, gap: 6 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>{ext.tab ?? ext.id}</Text>
      <Text style={{ color: c.foregroundMuted }}>Extension {ext.id} v{ext.version}</Text>
      <Text style={{ color: c.foreground }}>Tools: {ext.tools.join(", ") || "none"}</Text>
      <Text style={{ color: c.foreground }}>Stage kinds: {ext.stageKinds.join(", ") || "none"}</Text>
    </ScrollView>
  );
}

export function FactoryScreen(props: PluginScreenProps) {
  const { theme } = props;
  const overview = useRpc(overviewRpc);
  const query = useQuery({ queryKey: ["factory", "overview"], queryFn: () => overview({}), refetchInterval: 15_000 });
  const modules = query.data?.settings?.modules;
  const tabs = useMemo(() => {
    const list: { key: string; label: string }[] = MODULES.filter((id) => modules?.[id] ?? true).map((id) => ({ key: id, label: TITLES[id] }));
    for (const e of query.data?.extensions ?? []) if (e.tab) list.push({ key: `ext:${e.id}`, label: e.tab });
    list.push({ key: SETTINGS_TAB, label: "Settings" });
    return list;
  }, [modules, query.data?.extensions]);
  const [picked, setPicked] = useState<string>("blueprints");
  const tab = tabs.some((t) => t.key === picked) ? picked : tabs[0].key;
  const c = theme.colors;

  let body;
  if (tab === SETTINGS_TAB) body = <SettingsTab {...props} />;
  else if (tab.startsWith("ext:")) {
    const ext = query.data?.extensions.find((e) => `ext:${e.id}` === tab);
    body = ext ? <ExtensionTab {...props} ext={ext} /> : null;
  } else {
    const Screen = SCREENS[tab as ModuleId];
    body = <Screen {...props} />;
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 10, borderBottomWidth: 1, borderBottomColor: c.border }}>
        {tabs.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setPicked(t.key)}
            style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: t.key === tab ? c.accent : c.border }}
          >
            <Text style={{ color: t.key === tab ? c.foreground : c.foregroundMuted, fontSize: 13 }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {query.data?.endpoint.error ? <Text style={{ color: c.statusDanger, padding: 10 }}>{query.data.endpoint.error}</Text> : null}
      <View style={{ flex: 1 }}>{body}</View>
    </View>
  );
}
