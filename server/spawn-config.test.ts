import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRole } from "./roles/loader";
import { resolveAgentConfig } from "./spawn-config";

const dir = path.join(__dirname, "..", "shared", "examples", "lab-roles");

describe("resolveAgentConfig", () => {
  it("joins a role's provider and model as provider/model, with mode and thinking", () => {
    expect(resolveAgentConfig({ provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "high" } as never, "claude/claude-sonnet-5-5")).toEqual({
      provider: "claude/claude-sonnet-5-5",
      modeId: "auto",
      thinkingOptionId: "high",
    });
  });

  it("fills what the role leaves out from the default, and never borrows another provider's model", () => {
    expect(resolveAgentConfig(null, "claude/claude-sonnet-5-5")).toEqual({ provider: "claude/claude-sonnet-5-5" });
    expect(resolveAgentConfig({ model: "claude-opus-5-5" } as never, "claude/claude-sonnet-5-5").provider).toBe("claude/claude-opus-5-5");
    expect(resolveAgentConfig({ provider: "codex" } as never, "claude/claude-sonnet-5-5").provider).toBe("codex");
    expect(resolveAgentConfig(null, "claude").provider).toBe("claude");
  });

  it.each(readdirSync(dir).filter((f) => f.endsWith(".yaml")))("the real lab role %s yields a provider/model string", (file) => {
    const role = parseRole(readFileSync(path.join(dir, file), "utf8"), file);
    const config = resolveAgentConfig(role, "claude/claude-sonnet-5-5");
    expect(config.provider).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/);
    if (role.model) expect(config.provider.endsWith(`/${role.model}`)).toBe(true);
    if (role.modeId) expect(config.modeId).toBe(role.modeId);
  });
});
