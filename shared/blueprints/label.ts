/** What a run is called (sidebar, titles, digests) and the scope its reused approvals are keyed by: blueprint-level templates over the run's vars. */
export interface Labelled {
  id: string;
  blueprint: string;
  vars: Record<string, string>;
  def?: { label?: string; approval_scope?: string };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

/** `{{name}}`, `{{vars.name}}`, `{{run.id}}` and `{{blueprint}}`; an unset variable renders empty (a label must never fail a run). */
export function renderRunTemplate(template: string, run: Labelled): string {
  return template
    .replace(PLACEHOLDER, (_m, name: string) => {
      if (name === "run.id") return run.id;
      if (name === "blueprint") return run.blueprint;
      return run.vars[name.startsWith("vars.") ? name.slice(5) : name] ?? "";
    })
    .trim();
}

/** The names a template uses, for the loader to check against the blueprint's vars. */
export function templateNames(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * The run's label: the blueprint's `label` rendered, else `ticket`, else `incident_id` (the format before `label` existed),
 * else `fallback` (the run id by default; some places have always used the blueprint name or nothing).
 */
export function runLabel(run: Labelled, fallback: string = run.id): string {
  return customLabel(run) || run.vars.ticket || run.vars.incident_id || fallback;
}

/** The blueprint's own label rendered, or undefined when it sets none (or it renders empty): workspace titles keep their ticket title then. */
export function customLabel(run: Labelled): string | undefined {
  return (run.def?.label ? renderRunTemplate(run.def.label, run) : "") || undefined;
}

/**
 * The scope of a reused approval, the first part of its key `<scope>:<gate>:<criteria sha>`. Without `approval_scope` it is
 * `ticket`, else the blueprint name: byte-identical to the key before `approval_scope` existed, so stored approvals still match.
 */
export function approvalScope(run: Labelled): string {
  if (run.def?.approval_scope) return renderRunTemplate(run.def.approval_scope, run) || run.blueprint;
  return run.vars.ticket || run.blueprint;
}

export function approvalKey(run: Labelled, gate: string, criteriaSha: string): string {
  return `${approvalScope(run)}:${gate}:${criteriaSha}`;
}
