import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";

export function NoteRow({ item, theme, layout }: PluginTimelineItemProps<{ text: string }>) {
  return (
    <View style={{ paddingVertical: 4, paddingHorizontal: layout.compact ? 8 : 12 }}>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
        {item.data.text}
      </Text>
    </View>
  );
}
