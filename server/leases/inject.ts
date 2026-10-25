export const SCOPE_ENV = "PASEO_LEASES";
export const TOOL_NAMES = ["lease_acquire", "lease_renew", "lease_release", "lease_list"];

export function scopeApplies(scope: "all" | "opt-in", env: Record<string, string> | undefined): boolean {
  const value = env?.[SCOPE_ENV]?.toLowerCase();
  if (value === "off") return false;
  return scope === "all" || value === "on";
}

export const NOTE =
  "Agents Leases: before working on a resource other agents may touch (a PR, a QA environment, anything shared), take its named lease with lease_acquire. " +
  "Keep the returned token, renew before the TTL ends, release when done. If you are queued, end your turn: a message starting with \"Agents Leases:\" wakes you when it is yours. " +
  "A message saying you lost a lease means stop working on that resource at once.";
