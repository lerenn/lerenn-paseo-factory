export const SCOPE_ENV = "PASEO_WARDEN";
export const TOOL_NAMES = ["warden_register", "warden_register_subagent", "warden_update", "warden_done", "warden_list"];

/** Env value under the current name, else under the deprecated pre-rename name. */
export function envValue(env: Record<string, string | undefined> | undefined, name: string): string | undefined {
  return env?.[name] ?? env?.[name.replace("WARDEN", "WARDER")];
}

export function scopeApplies(scope: "factory" | "all" | "opt-in", env: Record<string, string> | undefined): boolean {
  const value = envValue(env, SCOPE_ENV)?.toLowerCase();
  if (value === "off") return false;
  // "factory": the Factory's own workers and PM, or an agent that opts in (extensions set PASEO_WARDEN=on on theirs).
  if (scope === "factory") return value === "on" || !!env?.PASEO_FACTORY_RUN || env?.PASEO_FACTORY_BLUEPRINTS === "on";
  return scope === "all" || value === "on";
}

export const NOTE =
  "Warden: for long work or anything you wait on (builds, CI, reviews, subagents), call warden_register(task, interval_minutes) so you " +
  "get a prompt if you go quiet. Call warden_update with progress and warden_done when finished. " +
  "If you manage subagents, warden_register_subagent watches one of them.";
