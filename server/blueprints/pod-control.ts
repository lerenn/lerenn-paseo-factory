/**
 * Suspend and wake the pod of a workspace through the Kubernetes Runtime plugin (the `podAction` behind its Pods screen: the same
 * path as its idle suspend, the volume is kept). Plugins share a process, so the Runtime offers it on `globalThis`.
 */
export const POD_CONTROL_KEY = Symbol.for("paseo.kubernetes-runtime");

export interface PodControl {
  podAction(workspaceId: string, action: "suspend" | "resume", options: { force?: boolean }): Promise<{ ok: boolean; message?: string; busy?: string }>;
}

const control = (): PodControl | null => ((globalThis as Record<symbol, unknown>)[POD_CONTROL_KEY] as PodControl | undefined) ?? null;

export async function suspendPod(workspaceId: string, force: boolean): Promise<{ ok: boolean; message?: string }> {
  const c = control();
  if (!c) return { ok: false, message: "the Kubernetes Runtime offers no pod control to other plugins" };
  const out = await c.podAction(workspaceId, "suspend", { force });
  return out.ok ? { ok: true } : { ok: false, message: out.busy ? `busy: ${out.busy}` : (out.message ?? "refused") };
}

export async function wakePod(workspaceId: string): Promise<void> {
  const out = await control()?.podAction(workspaceId, "resume", {});
  if (out && !out.ok) throw new Error(out.message ?? "refused");
}
