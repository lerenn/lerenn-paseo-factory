import { afterEach, describe, expect, it } from "vitest";
import { agentExcluded, pathExcluded, setExclusions } from "./exclusions";
import { listAgents } from "./list-agents";
import { spawnAgent } from "./spawn-agent";

const MONO = "/home/me/src/github.com/example/secret-project";
afterEach(() => setExclusions({ paths: [], agents: [] }));

describe("exclusions", () => {
  it("match a project by path, its subfolders and worktrees, but not a sibling with the same prefix", () => {
    setExclusions({ paths: [MONO], agents: ["gone-1"] });
    expect(pathExcluded(MONO)).toBe(true);
    expect(pathExcluded(`${MONO}/services/api`)).toBe(true);
    expect(pathExcluded(`${MONO}-other`)).toBe(false);
    expect(agentExcluded({ id: "gone-1", cwd: "/x" })).toBe(true);
    expect(agentExcluded({ id: "new-id-after-recreate", cwd: MONO })).toBe(true);
    expect(agentExcluded({ id: "a", cwd: "/home/paseo/src/github.com/lerenn/paseo-plugins" })).toBe(false);
  });

  it("listAgents hides excluded agents from every Factory lookup", async () => {
    setExclusions({ paths: [MONO], agents: [] });
    const paseo = { agents: { list: async () => ({ entries: [{ agent: { id: "sec", cwd: MONO } }, { agent: { id: "ok", cwd: "/repo" } }] }) } };
    const { entries } = await listAgents(paseo as never);
    expect(entries.map((e) => e.agent.id)).toEqual(["ok"]);
  });

  it("spawnAgent refuses a working directory inside an excluded project", async () => {
    setExclusions({ paths: [MONO], agents: [] });
    await expect(spawnAgent({} as never, "local", { idempotencyKey: "k", config: {}, cwd: MONO, title: "t", workspaceTitle: "t", prompt: "", labels: {}, env: {} })).rejects.toThrow(/excluded/);
  });
});
