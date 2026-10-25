import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSourceSchema } from "../shared/settings";
import type { Forge, PullRequest } from "./forge";
import { GitSources } from "./git-sync";
import { ProposalStore } from "./proposals";
import { RolesService } from "./service";
import { git, makeOrigin, tmp } from "./testing";
import { TokenStore } from "./tokens";

/** Pretends every repository is on a forge, recording the pull requests it is asked to open. */
function fakeForge() {
  const created: unknown[] = [];
  let state: PullRequest["state"] = "open";
  const forge: Forge = {
    id: "fake",
    parse: (url) => (url.startsWith("/") ? { owner: "o", name: "r" } : null),
    compareUrl: (_r, d) => `https://forge.test/compare/${d.base}...${d.head}`,
    async createPullRequest(_r, token, draft) {
      created.push({ token, ...draft });
      return { number: 3, url: "https://forge.test/pull/3", state: "open" };
    },
    async getPullRequest() {
      return { number: 3, url: "https://forge.test/pull/3", state };
    },
  };
  return { forge, created, setState: (s: PullRequest["state"]) => (state = s) };
}

async function setup(over: Record<string, unknown> = {}) {
  const origin = await makeOrigin();
  const root = await tmp();
  const sources = new GitSources(path.join(root, "git"));
  const source = gitSourceSchema.parse({ url: origin.bare, ref: "main", path: "roles", ...over });
  await sources.sync(source);
  const forge = fakeForge();
  const tokens = new TokenStore(path.join(root, "tokens.json"));
  const service = new RolesService({
    sources,
    tokens,
    proposals: new ProposalStore(path.join(root, "proposals.json")),
    configured: async () => [source],
    forges: [forge.forge],
  });
  return { origin, sources, source, service, tokens, forge, root };
}

describe("RolesService", () => {
  it("records a proposal with commit, branch, prefilled title/body and compare URL", async () => {
    const { service, source } = await setup();
    const p = await service.save(service.id(source), "name: ev\nmodel: v2");
    expect(p).toMatchObject({
      outcome: "branch",
      title: "agents-roles: update ev",
      sourceLabel: `${source.url}@main`,
      compareUrl: `https://forge.test/compare/main...${p.branch}`,
    });
    expect(p.body).toContain("- roles/ev.yaml (modified)");
    expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await service.proposals())[0].id).toBe(p.id);
  });

  it("opens the pull request through the forge when a token is set, and tracks its state", async () => {
    const { service, source, tokens, forge } = await setup();
    const p = await service.save(service.id(source), "name: ev\nmodel: v2");
    await expect(service.createPullRequest(p.id)).rejects.toThrow(/No forge token/);
    tokens.set(service.id(source), "tok");
    const opened = await service.createPullRequest(p.id);
    expect(opened.pr).toEqual({ number: 3, url: "https://forge.test/pull/3", state: "open" });
    expect(forge.created[0]).toMatchObject({ token: "tok", title: "agents-roles: update ev", base: "main", head: p.branch });
    forge.setState("merged");
    expect((await service.proposals())[0].pr?.state).toBe("merged");
  });

  it("never exposes the token in statuses or errors", async () => {
    const { service, source, tokens, forge } = await setup();
    expect(service.statuses([source])[0]).toMatchObject({ hasToken: false, forge: "fake", writeMode: "pull-request" });
    tokens.set(service.id(source), "super-secret");
    expect(JSON.stringify(service.statuses([source]))).not.toContain("super-secret");
    const p = await service.save(service.id(source), "name: ev\nmodel: v2");
    forge.forge.createPullRequest = async (_r, token) => {
      throw new Error(`boom ${token}`);
    };
    const error = await service.createPullRequest(p.id).catch((e: Error) => e);
    expect((error as Error).message).toBe("boom ***");
    expect(JSON.stringify(await service.proposals())).not.toContain("super-secret");
  });

  it("push mode: a rejected push becomes a proposal on a branch", async () => {
    const { service, source, origin } = await setup({ writeMode: "push" });
    origin.protectMain();
    const p = await service.save(service.id(source), "name: ev\nmodel: v3");
    expect(p).toMatchObject({ outcome: "branch" });
    expect(p.fellBack).toBeTruthy();
    expect(p.compareUrl).toBeTruthy();
  });

  it("explains an unsaved edit and suggests pull-request mode in push mode", async () => {
    const { service, source, origin } = await setup({ writeMode: "push" });
    await (await import("node:fs/promises")).rm(origin.bare, { recursive: true });
    await expect(service.save(service.id(source), "name: ev\nmodel: x")).rejects.toThrow(/Not saved.*pull-request mode/);
  });

  it("lists roles from the configured sources, tagged with their source id", async () => {
    const { service, source } = await setup();
    const roles = await service.list();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ name: "ev", sourceId: service.id(source) });
  });

  it("creates a new role through a proposal", async () => {
    const { service, source } = await setup();
    const p = await service.save(service.id(source), "name: fresh\nsystemPrompt: hi\n");
    expect(p).toMatchObject({ role: "fresh", action: "create", title: "agents-roles: create fresh" });
    expect(p.body).toContain("(added)");
  });

  it("rejects an invalid role before touching git", async () => {
    const { service, source } = await setup();
    await expect(service.save(service.id(source), "name: Bad Name")).rejects.toThrow(/name/);
    await expect(service.save("nope", "name: x")).rejects.toThrow(/no longer configured/);
  });

  it("deletes a role through a proposal", async () => {
    const { service, source } = await setup();
    const p = await service.remove(service.id(source), "ev");
    expect(p).toMatchObject({ action: "delete", title: "agents-roles: delete ev" });
    expect(p.body).toContain("(removed)");
  });
});
