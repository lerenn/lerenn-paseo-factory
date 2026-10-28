import { randomBytes } from "node:crypto";
import type { Paseo } from "./host";
import { pathExcluded } from "./exclusions";
import { setWorkspaceTitle } from "./workspace-title";

export type Runtime = "kubernetes" | "local";

export interface SpawnAgentInput {
  idempotencyKey: string;
  config: Record<string, unknown>;
  cwd: string;
  /** Agent title. */
  title: string;
  /** Workspace title ("<Role>[: <subject>]"). */
  workspaceTitle: string;
  prompt: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  /** Kubernetes: put the agent in this existing workspace (pod) instead of creating one. */
  joinWorkspaceId?: string;
}

/** Paseo's worktree slug rule: names the pod and the branch. */
export function slugFor(title: string, suffix: string = randomBytes(2).toString("hex")): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `${base || "factory"}-${suffix}`;
}

/**
 * Create a Factory agent in its own workspace on the configured runtime.
 * kubernetes: the workspace is a pod (same call as the Kubernetes Runtime plugin's location picker; the `runtime` field is newer than the pinned client types).
 * local: the agent runs on the daemon, as before.
 */
export async function spawnAgent(paseo: Paseo, runtime: Runtime, o: SpawnAgentInput): Promise<{ agentId: string; workspaceId: string | null }> {
  if (pathExcluded(o.cwd)) throw new Error(`${o.cwd} is excluded from the Factory (Factory setting excludePaths): pick another working directory.`);
  const agent = { idempotencyKey: o.idempotencyKey, config: o.config, title: o.title, prompt: o.prompt, labels: o.labels, env: o.env };
  if (runtime === "local") {
    const handle = await paseo.agents.create({ ...agent, cwd: o.cwd } as never);
    await setWorkspaceTitle(paseo, handle.id, o.workspaceTitle);
    return { agentId: handle.id, workspaceId: null };
  }
  if (o.joinWorkspaceId) {
    const handle = await paseo.workspaces.ref(o.joinWorkspaceId).agents.create(agent as never);
    return { agentId: handle.id, workspaceId: o.joinWorkspaceId };
  }
  const slug = slugFor(o.workspaceTitle, o.idempotencyKey.replace(/[^a-z0-9]/gi, "").slice(-4).toLowerCase() || undefined);
  const workspace = await paseo.workspaces.create({
    source: { kind: "directory", path: o.cwd },
    title: o.workspaceTitle,
    idempotencyKey: `ws:${o.idempotencyKey}`,
    runtime: { id: "kubernetes", options: { cwd: o.cwd, slug, ref: null, title: o.workspaceTitle } },
  } as never);
  const handle = await workspace.agents.create(agent as never);
  return { agentId: handle.id, workspaceId: workspace.id };
}
