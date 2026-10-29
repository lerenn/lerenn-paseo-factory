import { MODULES, type ModuleId } from "../shared/settings";

export type TabEntry = { key: string; label: string };

/** The Factory's top tab row: Overview, Supervisor (when on), Activity, the other modules that are on, Settings. */
export function builtinTabs(modules: Partial<Record<ModuleId, boolean>> | undefined, titles: Record<ModuleId, string>, keys: { overview: string; activity: string; settings: string }): TabEntry[] {
  return [
    { key: keys.overview, label: "Overview" },
    ...((modules?.supervisor ?? true) ? [{ key: "supervisor", label: "Supervisor" }] : []),
    { key: keys.activity, label: "Activity" },
    ...MODULES.filter((id) => id !== "supervisor" && (modules?.[id] ?? true)).map((id) => ({ key: id as string, label: titles[id] })),
    { key: keys.settings, label: "Settings" },
  ];
}
