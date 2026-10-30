/**
 * Suspend and wake a workspace through the runtime it runs on. Plugins share a process, so a runtime plugin offers this
 * capability on `globalThis[Symbol.for("paseo.workspace-control")]`: a registry keyed by runtime id (the `runtime.id` of
 * `workspaces.create`, the Factory's `runtime` setting), each entry a `WorkspaceControl`. Suspend keeps the workspace's
 * volume; wake brings it back. The Factory calls nothing else.
 */
export const WORKSPACE_CONTROL_KEY = Symbol.for("paseo.workspace-control");

export interface ControlResult {
  ok: boolean;
  message?: string;
  /** Why a suspend was refused without `force` (an agent is running in it). */
  busy?: string;
}

export interface WorkspaceControl {
  suspend(workspaceId: string, options: { force?: boolean }): Promise<ControlResult>;
  wake(workspaceId: string): Promise<ControlResult>;
}

/**
 * Legacy, read for one release so a Kubernetes Runtime that predates the registry still works: the Runtime's own key and its
 * `podAction`. Remove once every Runtime registers WORKSPACE_CONTROL_KEY.
 */
export const LEGACY_POD_CONTROL_KEY = Symbol.for("paseo.kubernetes-runtime");
const LEGACY_RUNTIME = "kubernetes";

interface LegacyPodControl {
  podAction(workspaceId: string, action: "suspend" | "resume", options: { force?: boolean }): Promise<ControlResult>;
}

/** The control the runtime `runtime` registered, or null. */
export function workspaceControl(runtime: string, target: Record<symbol, unknown> = globalThis as Record<symbol, unknown>): WorkspaceControl | null {
  const registry = target[WORKSPACE_CONTROL_KEY] as Record<string, WorkspaceControl | undefined> | undefined;
  const found = registry?.[runtime];
  if (found) return found;
  const legacy = runtime === LEGACY_RUNTIME ? (target[LEGACY_POD_CONTROL_KEY] as LegacyPodControl | undefined) : undefined;
  if (!legacy) return null;
  return {
    suspend: (workspaceId, options) => legacy.podAction(workspaceId, "suspend", options),
    wake: (workspaceId) => legacy.podAction(workspaceId, "resume", {}),
  };
}

export async function suspendWorkspace(runtime: string, workspaceId: string, force: boolean): Promise<{ ok: boolean; message?: string }> {
  const c = workspaceControl(runtime);
  if (!c) return { ok: false, message: `the ${runtime} runtime offers no workspace control to other plugins` };
  const out = await c.suspend(workspaceId, { force });
  return out.ok ? { ok: true } : { ok: false, message: out.busy ? `busy: ${out.busy}` : (out.message ?? "refused") };
}

export async function wakeWorkspace(runtime: string, workspaceId: string): Promise<void> {
  const out = await workspaceControl(runtime)?.wake(workspaceId);
  if (out && !out.ok) throw new Error(out.message ?? "refused");
}
