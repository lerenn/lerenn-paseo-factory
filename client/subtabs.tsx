import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

type Theme = { colors: Record<string, string> };

/** The sub-tab bar every Factory module uses under its title: `tabs` render lazily, the first is the default. */
export function SubTabs({ theme, tabs, initial }: { theme: Theme; tabs: { key: string; label: string; badge?: number; render(): ReactNode }[]; initial?: string }) {
  const c = theme.colors;
  const [picked, setPicked] = useState(initial ?? tabs[0].key);
  const current = tabs.find((t) => t.key === picked) ?? tabs[0];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", gap: 16, paddingHorizontal: 16, paddingTop: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
        {tabs.map((t) => (
          <Pressable key={t.key} onPress={() => setPicked(t.key)} style={{ paddingVertical: 6, borderBottomWidth: 2, borderBottomColor: t.key === current.key ? c.accent : "transparent" }}>
            <Text style={{ color: t.key === current.key ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: t.key === current.key ? "600" : "400" }}>
              {t.label}
              {t.badge ? ` (${t.badge})` : ""}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flex: 1 }}>{current.render()}</View>
    </View>
  );
}
