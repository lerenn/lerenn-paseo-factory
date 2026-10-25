import { describe, expect, it } from "vitest";
import { roleSchema } from "../../shared/roles/role";
import { applyRole } from "./apply";

const base = { config: { provider: "claude", cwd: "/work" }, env: { PASEO_AGENT_ROLE: "r" } };
const role = (extra: object) => roleSchema.parse({ name: "r", ...extra });

describe("applyRole", () => {
  it("sets model, mode and provider only when the role defines them", () => {
    const out = applyRole(base, role({ model: "m", modeId: "plan", provider: "codex" }));
    expect(out.config).toMatchObject({ provider: "codex", model: "m", modeId: "plan", cwd: "/work" });
    expect(applyRole(base, role({})).config).toEqual(base.config);
  });

  it("prepends the role prompt to an existing one", () => {
    const req = { ...base, config: { ...base.config, systemPrompt: "mine" } };
    expect(applyRole(req, role({ systemPrompt: "role" })).config.systemPrompt).toBe("role\n\nmine");
    expect(applyRole(base, role({ systemPrompt: "role" })).config.systemPrompt).toBe("role");
  });

  it("passes MCP server names to the MCP proxy through PASEO_MCP_SERVERS", () => {
    const out = applyRole(base, role({ mcpServers: ["linear", "sentry"] }));
    expect(out.env?.PASEO_MCP_SERVERS).toBe("linear,sentry");
    expect(out.config.mcpServers).toBeUndefined();
    expect(applyRole(base, role({ mcpServers: ["*"] })).env?.PASEO_MCP_SERVERS).toBe("*");
    expect(applyRole(base, role({})).env).not.toHaveProperty("PASEO_MCP_SERVERS");
    const explicit = applyRole({ ...base, env: { ...base.env, PASEO_MCP_SERVERS: "only-this" } }, role({ mcpServers: ["linear"] }));
    expect(explicit.env?.PASEO_MCP_SERVERS).toBe("only-this");
  });

  it("rejects MCP server entries that are not plain names", () => {
    expect(roleSchema.safeParse({ name: "r", mcpServers: [{ type: "http", url: "https://x" }] }).success).toBe(false);
    expect(roleSchema.safeParse({ name: "r", mcpServers: ["https://x"] }).success).toBe(false);
  });

  it("sets other plugins' defaults as the env they read, below role env and creation env", () => {
    const r = role({ plugins: { kubeTemplate: "dev", warder: "off", ticket: "ANY-1" }, env: { PASEO_KUBE_TEMPLATE: "from-env" } });
    expect(applyRole(base, r).env).toMatchObject({
      PASEO_KUBE_TEMPLATE: "from-env",
      PASEO_WARDER: "off",
      PASEO_AGENT_TICKET: "ANY-1",
    });
    const explicit = applyRole({ ...base, env: { ...base.env, PASEO_AGENT_TICKET: "ANY-9" } }, r);
    expect(explicit.env?.PASEO_AGENT_TICKET).toBe("ANY-9");
    expect(applyRole(base, role({})).env).toEqual({ PASEO_AGENT_ROLE: "r" });
  });

  it("maps plugins.warder to PASEO_WARDER and PASEO_WARDER_INTERVAL", () => {
    const env = (warder: unknown) => applyRole(base, role({ plugins: { warder } })).env;
    expect(env("off")).toMatchObject({ PASEO_WARDER: "off" });
    expect(env("off")).not.toHaveProperty("PASEO_WARDER_INTERVAL");
    expect(env({ mode: "on", interval: "15m" })).toMatchObject({ PASEO_WARDER: "on", PASEO_WARDER_INTERVAL: "15m" });
    expect(env({ interval: "900" })).toMatchObject({ PASEO_WARDER_INTERVAL: "900" });
    expect(env({ interval: "1h30m" })).toMatchObject({ PASEO_WARDER_INTERVAL: "1h30m" });
    expect(env({ interval: "900" })).not.toHaveProperty("PASEO_WARDER");
    const explicit = applyRole({ ...base, env: { ...base.env, PASEO_WARDER_INTERVAL: "5m" } }, role({ plugins: { warder: { interval: "15m" } } }));
    expect(explicit.env?.PASEO_WARDER_INTERVAL).toBe("5m");
  });

  it("rejects a bad warder interval", () => {
    for (const interval of ["soon", "", "-5m", "15 minutes"]) {
      expect(roleSchema.safeParse({ name: "r", plugins: { warder: { interval } } }).success).toBe(false);
    }
  });

  it("resolves ${NAME} references from the daemon environment", () => {
    const r = role({ env: { API_TOKEN: "${GH_TOKEN}", URL: "https://${HOST}/x", PLAIN: "v" } });
    const out = applyRole(base, r, { GH_TOKEN: "abc", HOST: "h" });
    expect(out.env).toMatchObject({ API_TOKEN: "abc", URL: "https://h/x", PLAIN: "v" });
    expect(() => applyRole(base, r, { HOST: "h" })).toThrow(/API_TOKEN references \$\{GH_TOKEN\}, which is not set on the daemon/);
  });

  it("refuses secrets written into a role", () => {
    const bad = (env: Record<string, string>) => roleSchema.safeParse({ name: "r", env });
    expect(bad({ GITHUB_TOKEN: "ghp_" + "a".repeat(30) }).success).toBe(false);
    expect(bad({ SOME: "sk-" + "b".repeat(30) }).success).toBe(false);
    expect(bad({ DB_PASSWORD: "hunter2" }).success).toBe(false);
    expect(bad({ API_KEY: "literal" }).success).toBe(false);
    expect(bad({ SOME: "-----BEGIN RSA PRIVATE KEY-----" }).success).toBe(false);
    expect(bad({ GITHUB_TOKEN: "${GH_TOKEN}" }).success).toBe(true);
    expect(bad({ LOG_LEVEL: "debug", PASEO_KUBE_TEMPLATE: "t" }).success).toBe(true);
    const message = bad({ API_KEY: "literal" }).error?.issues[0].message;
    expect(message).toMatch(/reference it as \$\{NAME\}/);
  });

  it("appends preapproved tools", () => {
    const out = applyRole(base, role({ preapprovedTools: [{ server: "s", tool: "t" }] }));
    expect(out.config.toolPolicy?.preapproved).toEqual([{ kind: "mcp", server: "s", tool: "t" }]);
  });

  it("merges provider options", () => {
    const req = { ...base, config: { ...base.config, providerOptions: { a: 1, b: 1 } } };
    const out = applyRole(req, role({ providerOptions: { b: 2 } }));
    expect(out.config.providerOptions).toEqual({ a: 1, b: 2 });
  });

  it("lets creation-time env beat role env, and records the role name", () => {
    const req = { ...base, env: { PASEO_AGENT_ROLE: "r", PASEO_KUBE_TEMPLATE: "explicit" } };
    const out = applyRole(req, role({ env: { PASEO_KUBE_TEMPLATE: "from-role", OTHER: "1" } }));
    expect(out.env).toEqual({ PASEO_AGENT_ROLE: "r", PASEO_KUBE_TEMPLATE: "explicit", OTHER: "1" });
  });

  it("does not mutate the request", () => {
    const snapshot = structuredClone(base);
    applyRole(base, role({ model: "m", env: { X: "1" } }));
    expect(base).toEqual(snapshot);
  });
});
