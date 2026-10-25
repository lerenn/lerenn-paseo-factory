import { describe, expect, it } from "vitest";
import { createGitHubForge, forgeFor } from "./forge";

const repo = { owner: "acme", name: "roles" };

describe("github forge", () => {
  const forge = createGitHubForge();

  it("recognises GitHub clone URLs only", () => {
    for (const url of [
      "git@github.com:acme/roles.git",
      "ssh://git@github.com/acme/roles",
      "https://github.com/acme/roles.git",
      "https://user:tok@github.com/acme/roles/",
    ]) {
      expect(forge.parse(url)).toEqual(repo);
    }
    expect(forge.parse("https://gitlab.com/acme/roles.git")).toBeNull();
    expect(forge.parse("/tmp/repo")).toBeNull();
    expect(forgeFor("git@github.com:a/b.git")?.forge.id).toBe("github");
  });

  it("builds a prefilled compare URL", () => {
    const url = new URL(forge.compareUrl(repo, { title: "agents-roles: update qa", body: "- roles/qa.yaml", base: "main", head: "agents-roles/qa-1" }));
    expect(url.pathname).toBe("/acme/roles/compare/main...agents-roles%2Fqa-1");
    expect(url.searchParams.get("title")).toBe("agents-roles: update qa");
    expect(url.searchParams.get("body")).toBe("- roles/qa.yaml");
    expect(url.searchParams.get("expand")).toBe("1");
  });

  it("creates and reads pull requests through the API", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const merged = init.method === "GET";
      return new Response(
        JSON.stringify({ number: 7, html_url: "https://github.com/acme/roles/pull/7", state: merged ? "closed" : "open", merged }),
        { status: init.method === "POST" ? 201 : 200 },
      );
    }) as unknown as typeof fetch;
    const f = createGitHubForge(fake);
    const created = await f.createPullRequest(repo, "tok", { title: "t", body: "b", base: "main", head: "h" });
    expect(created).toEqual({ number: 7, url: "https://github.com/acme/roles/pull/7", state: "open" });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/roles/pulls");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ title: "t", body: "b", head: "h", base: "main" });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect((await f.getPullRequest(repo, "tok", 7)).state).toBe("merged");
  });

  it("explains API failures without leaking the token", async () => {
    const fake = (async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as unknown as typeof fetch;
    await expect(createGitHubForge(fake).createPullRequest(repo, "secret-token", { title: "", body: "", base: "m", head: "h" })).rejects.toThrow(
      /GitHub 404: Not Found.*pull request write access/,
    );
  });
});
