/** The Blueprints sub-tabs, in display order; the first is the default. Crons and Quota sit here, not in the Factory's top row. */
export const BLUEPRINTS_SUBTABS = [
  { key: "runs", label: "Runs" },
  { key: "templates", label: "Templates" },
  { key: "crons", label: "Crons" },
  { key: "quota", label: "Quota" },
  { key: "settings", label: "Settings" },
] as const;
