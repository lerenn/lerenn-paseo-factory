import type { Role } from "../shared/roles/role";

/** What `agents.create` needs from a role: `provider/model` in one string, plus mode and thinking. */
export interface AgentConfigParts {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
}

/**
 * Paseo wants `config.provider` as "provider/model". Roles declare them apart (`provider: claude`, `model: ...`);
 * the setting `defaultProvider` may be "provider" or "provider/model" and fills what the role leaves out.
 */
export function resolveAgentConfig(role: Pick<Role, "provider" | "model" | "modeId" | "thinkingOptionId"> | null, fallback: string): AgentConfigParts {
  const [fallbackProvider, ...rest] = fallback.split("/");
  const fallbackModel = rest.join("/") || undefined;
  const provider = role?.provider ?? fallbackProvider;
  const model = role?.model ?? (role?.provider && role.provider !== fallbackProvider ? undefined : fallbackModel);
  return {
    provider: model ? `${provider}/${model}` : provider,
    ...(role?.modeId ? { modeId: role.modeId } : {}),
    ...(role?.thinkingOptionId ? { thinkingOptionId: role.thinkingOptionId } : {}),
  };
}
