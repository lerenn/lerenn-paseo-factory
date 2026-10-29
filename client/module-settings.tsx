import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

type Theme = { colors: Record<string, string> };

export type SettingField =
  | { key: string; label: string; kind: "bool"; hint?: string }
  | { key: string; label: string; kind: "number"; hint?: string }
  | { key: string; label: string; kind: "text"; hint?: string }
  | { key: string; label: string; kind: "select"; options: { label: string; value: string }[]; hint?: string };

const SCOPE: SettingField = {
  key: "scope",
  label: "Who gets the tools",
  kind: "select",
  options: [
    { label: "All agents (PASEO_<MODULE>=off opts out)", value: "all" },
    { label: "Only agents created with PASEO_<MODULE>=on", value: "opt-in" },
  ],
};

export const LEASES_FIELDS: SettingField[] = [
  { key: "enabled", label: "Enabled", kind: "bool" },
  SCOPE,
  { key: "tickSeconds", label: "Tick (seconds)", kind: "number", hint: "How often leases are checked for expiry." },
  { key: "maxTtlSeconds", label: "Longest lease (seconds)", kind: "number" },
  { key: "maxDeliveryAttempts", label: "Delivery attempts", kind: "number" },
  { key: "retentionDays", label: "Audit retention (days)", kind: "number" },
  { key: "grantedTemplate", label: "Granted message", kind: "text" },
  { key: "lostTemplate", label: "Lost message", kind: "text" },
  { key: "expiredTemplate", label: "Expired message (nobody else holds it)", kind: "text" },
];

export const WARDEN_FIELDS: SettingField[] = [
  { key: "enabled", label: "Enabled", kind: "bool" },
  SCOPE,
  { key: "tickSeconds", label: "Tick (seconds)", kind: "number" },
  { key: "globalGapSeconds", label: "Minimum gap between prompts (seconds)", kind: "number" },
  { key: "idleGraceSeconds", label: "Idle grace (seconds)", kind: "number", hint: "An agent whose turn ended without warden_done is pinged after this." },
  { key: "maxIntervalMinutes", label: "Hang backstop (minutes)", kind: "number" },
  { key: "backoffFactor", label: "Backoff factor", kind: "number" },
  { key: "maxBackoffIntervals", label: "Max backoff intervals", kind: "number" },
  { key: "notifyParentAfterPings", label: "Notify the parent after N pings", kind: "number" },
  { key: "maxUnansweredPings", label: "Give up after N unanswered pings", kind: "number" },
  { key: "superviseReactMinutes", label: "Parent reaction time (minutes)", kind: "number" },
  { key: "pingTemplate", label: "Ping message", kind: "text" },
  { key: "idlePingTemplate", label: "Idle ping message", kind: "text" },
  { key: "parentTemplate", label: "Parent notice", kind: "text" },
  { key: "announcedWork.enabled", label: "Detect announced work", kind: "bool", hint: "Register a task when an agent ends a turn announcing future work." },
  { key: "announcedWork.intervalMinutes", label: "Announced-work interval (minutes)", kind: "number" },
];

export const INBOX_FIELDS: SettingField[] = [
  { key: "enabled", label: "Enabled", kind: "bool" },
  SCOPE,
  { key: "tickSeconds", label: "Tick (seconds)", kind: "number" },
  { key: "globalGapSeconds", label: "Minimum gap between messages (seconds)", kind: "number" },
  { key: "maxDeliveryAttempts", label: "Delivery attempts", kind: "number" },
  { key: "defaultExpiryMinutes", label: "Default expiry (minutes, 0 = never)", kind: "number" },
  { key: "retentionDays", label: "Retention (days)", kind: "number" },
  { key: "answerTemplate", label: "Answer message", kind: "text" },
  { key: "expiredTemplate", label: "Expired message", kind: "text" },
];

function getPath(obj: any, key: string): any {
  return key.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setPath(obj: any, key: string, value: unknown): any {
  const [head, ...rest] = key.split(".");
  return { ...obj, [head]: rest.length ? setPath(obj?.[head] ?? {}, rest.join("."), value) : value };
}

/** An editable settings form for one module: fields are edited locally and saved together. */
export function ModuleSettings({ theme, definition, fields, title }: { theme: Theme; definition: Parameters<typeof useSettings>[0]; fields: SettingField[]; title: string }) {
  const settings = useSettings(definition as never) as any;
  const c = theme.colors;
  const [draft, setDraft] = useState<any>(null);
  const revision = useRef<string | null>(null);
  if (settings.status === "ready" && (draft === null || revision.current !== settings.revision)) {
    revision.current = settings.revision;
    if (draft === null) setDraft(settings.values);
  }
  if (settings.status !== "ready" || draft === null) {
    return (
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={{ color: c.foregroundMuted }}>{settings.status === "loading" ? "Loading…" : `Settings: ${settings.error ?? ""}`}</Text>
      </ScrollView>
    );
  }
  const edit = (key: string, value: unknown) => setDraft((d: any) => setPath(d, key, value));
  const save = () => {
    let out = draft;
    for (const f of fields) {
      if (f.kind !== "number") continue;
      const n = Number(getPath(out, f.key));
      out = setPath(out, f.key, Number.isFinite(n) ? n : getPath(settings.values, f.key));
    }
    void settings.save(out, settings.revision);
  };
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 8 }}>
      <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>{title}</Text>
      <SettingsCard>
        {fields.map((f) => {
          const value = getPath(draft, f.key);
          if (f.kind === "bool") return <SettingsSwitch key={f.key} label={f.label} hint={f.hint} value={!!value} onValueChange={(v) => edit(f.key, v)} />;
          if (f.kind === "select") return <SettingsSelect key={f.key} label={f.label} hint={f.hint} value={String(value)} options={f.options} onValueChange={(v) => edit(f.key, v)} />;
          return <SettingsInput key={f.key} label={f.label} hint={f.hint} initialValue={String(value ?? "")} onChangeText={(t) => edit(f.key, t)} />;
        })}
      </SettingsCard>
      {settings.saveError ? <Text style={{ color: c.statusDanger }}>{settings.saveError}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Save settings" onPress={save} style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8, backgroundColor: c.accent }}>
          <Text style={{ color: c.accentForeground }}>{settings.saving ? "Saving…" : "Save"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Reset edits" onPress={() => setDraft(settings.values)} style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: c.border }}>
          <Text style={{ color: c.foreground }}>Discard edits</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
