import { listAgents } from "./list-agents";
import type { Paseo } from "./host";

const ACRONYMS = new Set(["pm", "pr", "qa", "ci", "ui", "api"]);
const MAX_SUBJECT = 80;

/** "pr-babysitter" -> "PR Babysitter", "supervisor" -> "Supervisor". */
export function roleDisplayName(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

const firstLine = (text: string | undefined): string => (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

const clip = (text: string): string => (text.length > MAX_SUBJECT ? `${text.slice(0, MAX_SUBJECT - 1).trimEnd()}…` : text);

/** What the work is about: the blueprint's own `label` when it sets one, else a ticket (key first, so it survives truncation), an incident, else the run. */
export function workspaceSubject(vars: Record<string, string> | undefined, runName: string | null, label?: string): string | null {
  if (label) return clip(label);
  const v = vars ?? {};
  const ticket = v.ticket?.trim();
  if (ticket) {
    const title = v.ticket_title?.trim() || firstLine(v.ticket_text);
    return clip(title && title !== ticket ? `${ticket} ${title}` : ticket);
  }
  if (v.incident_id?.trim()) return clip(v.incident_id.trim());
  const alert = firstLine(v.alert_text);
  if (alert) return clip(alert);
  return runName;
}

/** "<Role>[: <subject>]": the Factory names the workspace, the agent never does. The stage belongs to the badge. */
export function workspaceTitle(role: string, vars?: Record<string, string>, runName: string | null = null, label?: string): string {
  const subject = workspaceSubject(vars, runName, label);
  return subject ? `${roleDisplayName(role)}: ${subject}` : roleDisplayName(role);
}

/** Best effort: a rename failure must never fail a spawn. */
export async function setWorkspaceTitle(paseo: Paseo, agentId: string, title: string): Promise<void> {
  try {
    const found = await paseo.agents.ref(agentId).refresh();
    const workspaceId = found?.agent.workspaceId;
    if (!workspaceId) return;
    const handle = paseo.workspaces.ref(workspaceId);
    const current = await handle.refresh();
    if (current?.title === title) return;
    await handle.setTitle(title);
  } catch (error) {
    console.error("factory: could not title the workspace", error);
  }
}

type Listed = { id: string; labels?: Record<string, string> };

/** Re-title the workspaces of live Factory agents (startup, and after a turn when the host may have generated its own title). */
export async function retitleFactoryWorkspaces(paseo: Paseo, runVars: (runId: string) => { vars: Record<string, string>; blueprint: string; label?: string } | undefined, only?: string): Promise<void> {
  try {
    const { entries } = await listAgents(paseo);
    for (const { agent } of entries as { agent: Listed }[]) {
      if (only && agent.id !== only) continue;
      const labels = agent.labels ?? {};
      if (labels["paseo.factory"] !== "1" || !labels["paseo.factory.role"]) continue;
      const run = labels["paseo.factory.run"] ? runVars(labels["paseo.factory.run"]) : undefined;
      const runName = run ? `${run.blueprint} ${labels["paseo.factory.run"]}` : null;
      await setWorkspaceTitle(paseo, agent.id, workspaceTitle(labels["paseo.factory.role"], run?.vars, runName, run?.label));
    }
  } catch (error) {
    console.error("factory: workspace re-title failed", error);
  }
}
