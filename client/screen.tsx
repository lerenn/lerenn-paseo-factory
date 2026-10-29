import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useSyncExternalStore } from "react";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { BlueprintsScreen } from "./blueprints";
import { InboxScreen } from "./inbox";
import { LeasesScreen } from "./leases";
import { RolesScreen } from "./roles";
import { WardenScreen } from "./warden";
import { extensionCallRpc, overviewRpc } from "../shared/rpc";
import { GitSourcesSection } from "./git-sources";
import { ActivityScreen } from "./activity";
import { OverviewScreen } from "./overview";
import { SupervisorScreen } from "./supervisor/screen";
import { extensionTabView, subscribeTabs, tabFor, type ExtensionLink } from "./registry";
import { resolveLink } from "./extension-link";
import { builtinTabs } from "./tabs";
import { factorySettings, MODULES, type ModuleId } from "../shared/settings";

const TITLES: Record<ModuleId, string> = { blueprints: "Blueprints", roles: "Roles", leases: "Leases", warden: "Warden", inbox: "Inbox", supervisor: "Supervisor" };
const SCREENS = { blueprints: BlueprintsScreen, roles: RolesScreen, leases: LeasesScreen, warden: WardenScreen, inbox: InboxScreen };
const SETTINGS_TAB = "~settings";
const OVERVIEW_TAB = "~overview";
const ACTIVITY_TAB = "~activity";

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

function ExtensionTab({ theme, layout, ext, open }: PluginScreenProps & { ext: { id: string; version: string; tab: string | null; tools: string[]; stageKinds: string[] }; open(link: ExtensionLink): void }) {
  const c = theme.colors;
  const rpc = useRpc(extensionCallRpc);
  useSyncExternalStore(subscribeTabs, () => tabFor(ext.id));
  const view = extensionTabView(ext.id);
  const call = useCallback(
    async (name: string, input?: unknown) => {
      const out = await rpc({ id: ext.id, name, input });
      if (!out.ok) throw new Error(out.error ?? "extension call failed");
      return out.output;
    },
    [rpc, ext.id],
  );
  if (view.kind === "tab") return <view.Component theme={theme} layout={layout} extensionId={ext.id} call={call} open={open} />;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 16, gap: 6 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>{ext.tab ?? ext.id}</Text>
      <Text style={{ color: c.foregroundMuted }}>Extension {ext.id} v{ext.version}</Text>
      <Text style={{ color: c.foreground }}>Tools: {ext.tools.join(", ") || "none"}</Text>
      <Text style={{ color: c.foreground }}>Stage kinds: {ext.stageKinds.join(", ") || "none"}</Text>
    </ScrollView>
  );
}

function TabRow({ tabs, current, onPick, theme }: { tabs: { key: string; label: string; health?: "ok" | "degraded" }[]; current: string; onPick(key: string): void; theme: PluginScreenProps["theme"] }) {
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 10, flex: 1 }}>
      {tabs.map((t) => (
        <Pressable
          key={t.key}
          onPress={() => onPick(t.key)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: t.key === current ? c.accent : c.border }}
        >
          {t.health ? <View accessibilityLabel={t.health === "ok" ? "extension reachable" : "extension unreachable"} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.health === "ok" ? c.statusSuccess : c.statusWarning }} /> : null}
          <Text style={{ color: t.key === current ? c.foreground : c.foregroundMuted, fontSize: 13 }}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function FactoryScreen(props: PluginScreenProps) {
  const { theme } = props;
  const overview = useRpc(overviewRpc);
  const query = useQuery({ queryKey: ["factory", "overview"], queryFn: () => overview({}), refetchInterval: 15_000 });
  const modules = query.data?.settings?.modules;
  const { builtin, extensionTabs } = useMemo(() => {
    const builtin = builtinTabs(modules, TITLES, { overview: OVERVIEW_TAB, activity: ACTIVITY_TAB, settings: SETTINGS_TAB });
    const extensionTabs = (query.data?.extensions ?? []).filter((e) => e.tab).map((e) => ({ key: `ext:${e.id}`, label: e.tab as string, health: e.health }));
    return { builtin, extensionTabs };
  }, [modules, query.data?.extensions]);
  const tabs = useMemo(() => [...builtin, ...extensionTabs], [builtin, extensionTabs]);
  const [picked, setPicked] = useState<string>(OVERVIEW_TAB);
  /** The run or Inbox item an extension tab asked to show (`open(link)`); cleared by picking a tab by hand. */
  const [focus, setFocus] = useState<{ tab: string; id: string } | null>(null);
  const pick = useCallback((key: string) => {
    setFocus(null);
    setPicked(key);
  }, []);
  const open = useCallback((link: ExtensionLink) => {
    const target = resolveLink(link);
    if (!target) return;
    if ("url" in target) {
      void Linking.openURL(target.url).catch(() => undefined);
      return;
    }
    setFocus({ tab: target.tab, id: target.focus });
    setPicked(target.tab);
  }, []);
  const tab = tabs.some((t) => t.key === picked) ? picked : tabs[0].key;
  const focused = focus && focus.tab === tab ? focus.id : undefined;
  const c = theme.colors;

  let body;
  if (tab === "supervisor") body = <SupervisorScreen theme={theme} layout={props.layout} navigation={props.navigation} />;
  else if (tab === OVERVIEW_TAB) body = <OverviewScreen theme={theme} layout={props.layout} go={(k) => pick(k === "settings" ? SETTINGS_TAB : k)} />;
  else if (tab === ACTIVITY_TAB) body = <ActivityScreen theme={theme} layout={props.layout} go={(k) => pick(k === "settings" ? SETTINGS_TAB : k)} />;
  else if (tab === SETTINGS_TAB) body = <SettingsTab {...props} />;
  else if (tab.startsWith("ext:")) {
    const ext = query.data?.extensions.find((e) => `ext:${e.id}` === tab);
    body = ext ? <ExtensionTab {...props} ext={ext} open={open} /> : null;
  } else {
    const Screen = SCREENS[tab as keyof typeof SCREENS];
    body = <Screen key={focused ?? ""} {...props} focus={focused} />;
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <View style={{ borderBottomWidth: 1, borderBottomColor: c.border }}>
        <TabRow tabs={builtin} current={tab} onPick={pick} theme={theme} />
        {extensionTabs.length > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: c.border }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingLeft: 12, textTransform: "uppercase" }}>Extensions</Text>
            <TabRow tabs={extensionTabs} current={tab} onPick={pick} theme={theme} />
          </View>
        ) : null}
      </View>
      {query.data?.endpoint.error ? <Text style={{ color: c.statusDanger, padding: 10 }}>{query.data.endpoint.error}</Text> : null}
      <View style={{ flex: 1 }}>{body}</View>
    </View>
  );
}
