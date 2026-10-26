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
