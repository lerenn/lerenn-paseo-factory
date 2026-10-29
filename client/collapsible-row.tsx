import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

type Theme = { colors: Record<string, string> };

/**
 * A list item that is ONE line while closed: chevron, status pill, title (truncated), then the
 * secondary parts. The details show only when it is opened. Closed by default.
 */
export function CollapsibleRow({
  theme,
  pill,
  title,
  parts,
  bold,
  onOpen,
  initiallyOpen,
  children,
}: {
  theme: Theme;
  pill: { text: string; color: string };
  title: string;
  /** Short secondary strings after the title (agent title, "next ping in 5m", ...). */
  parts: (string | null | undefined)[];
  bold?: boolean;
  onOpen?(): void;
  /** Open when first shown (a row an extension tab linked to). */
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const c = theme.colors;
  const [open, setOpen] = useState(!!initiallyOpen);
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Collapse" : "Expand"} ${title}`}
        onPress={() => {
          if (!open) onOpen?.();
          setOpen((v) => !v);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 10 }}
      >
        <Text style={{ color: c.foregroundMuted, fontSize: 12, width: 12 }}>{open ? "▾" : "▸"}</Text>
        <View style={{ paddingVertical: 1, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: pill.color }}>
          <Text style={{ color: pill.color, fontSize: 11, fontWeight: "700" }}>{pill.text}</Text>
        </View>
        <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, fontWeight: bold ? "700" : "400", flexShrink: 1 }}>
          {title}
        </Text>
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, flexShrink: 2 }}>
          {parts.filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      {open ? <View style={{ gap: 4, paddingHorizontal: 12, paddingBottom: 10 }}>{children}</View> : null}
    </View>
  );
}
