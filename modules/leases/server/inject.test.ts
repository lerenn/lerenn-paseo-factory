import { describe, expect, it } from "vitest";
import { applyInjection, CAPABILITY_ENV, scopeApplies, TOOL_NAMES } from "./inject";

describe("scopeApplies", () => {
  it("honours off, on and the scope", () => {
    expect(scopeApplies("all", {})).toBe(true);
    expect(scopeApplies("all", { PASEO_LEASES: "off" })).toBe(false);
    expect(scopeApplies("opt-in", {})).toBe(false);
    expect(scopeApplies("opt-in", { PASEO_LEASES: "on" })).toBe(true);
  });
});

describe("applyInjection", () => {
  it("adds the MCP server with the capability, preapproves the tools and keeps existing config", () => {
    const request: any = { config: { systemPrompt: "base", mcpServers: { other: { type: "http", url: "u" } } }, env: { A: "1" } };
    const out: any = applyInjection(request, { url: "http://127.0.0.1:47826", capability: "cap" });
    expect(out.config.mcpServers.other).toBeDefined();
    expect(out.config.mcpServers.leases).toMatchObject({ url: "http://127.0.0.1:47826/mcp", headers: { authorization: "Bearer cap" } });
    expect(out.config.toolPolicy.preapproved.map((p: any) => p.tool)).toEqual(TOOL_NAMES);
    expect(out.config.systemPrompt).toContain("base");
    expect(out.config.systemPrompt).toContain("Agents Leases");
    expect(out.env).toEqual({ A: "1", [CAPABILITY_ENV]: "cap" });
  });
});
