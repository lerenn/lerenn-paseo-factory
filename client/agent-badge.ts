type Labels = Readonly<Record<string, string>>;

/** Text next to the badge icon: the blueprint and stage of a run agent. Empty (icon only) when neither is known, e.g. the Supervisor. */
export function badgeText(labels: Labels): string {
  const blueprint = labels["paseo.factory.blueprint"];
  const stage = labels["paseo.factory.stage"];
  return [blueprint, stage].filter(Boolean).join(" · ");
}

export function badgeTooltip(labels: Labels): string {
  if (labels["paseo.factory.supervisor"]) return "Factory agent (supervisor)";
  const run = labels["paseo.factory.run"];
  const role = labels["paseo.factory.role"];
  const parts = [run ? `Factory run ${run}` : "Factory agent", role ? `role ${role}` : ""];
  return parts.filter(Boolean).join(" · ");
}

export interface BadgeDef {
  id: string;
  scope: "workspace";
  match: { labels: Record<string, string> };
  render: { icon: string; text?(agent: { labels: Labels }): string; tooltip?(agent: { labels: Labels }): string };
}

/**
 * Two badges with disjoint matches, so no agent gets two and none renders an empty text: workers and PMs carry a run
 * label (blueprint · stage); the Supervisor has none, so it gets an icon-only badge.
 */
export const AGENT_BADGES: BadgeDef[] = [
  { id: "factory-run", scope: "workspace", match: { labels: { "paseo.factory.run": "*" } }, render: { icon: "Factory", text: (a) => badgeText(a.labels), tooltip: (a) => badgeTooltip(a.labels) } },
  { id: "factory-supervisor", scope: "workspace", match: { labels: { "paseo.factory.supervisor": "*" } }, render: { icon: "Factory", tooltip: (a) => badgeTooltip(a.labels) } },
];

/** Which badges an agent with these labels gets (`*` matches any value). */
export function badgesFor(labels: Labels): BadgeDef[] {
  return AGENT_BADGES.filter((b) => Object.entries(b.match.labels).every(([k, v]) => (v === "*" ? k in labels : labels[k] === v)));
}
