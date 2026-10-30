import { describe, expect, it } from "vitest";
import { PR_FACTS_PROVIDER_KEY, type PrFactsProvider } from "../shared/facts";
import { githubProvider, registerProvider } from "./provider";
import contribute from "../index.server";

const fake = (): PrFactsProvider => ({ matches: () => true, prFacts: async () => { throw new Error("unused"); } });

describe("registration", () => {
  it("offers the github provider in the Factory's registry, next to others, and removes only its own entry", () => {
    const other = fake();
    const target: Record<symbol, unknown> = { [PR_FACTS_PROVIDER_KEY]: { other } };
    const off = registerProvider(githubProvider, target);
    expect(target[PR_FACTS_PROVIDER_KEY]).toEqual({ other, github: githubProvider });
    off();
    expect(target[PR_FACTS_PROVIDER_KEY]).toEqual({ other });
  });

  it("a stale cleanup (after a reload registered again) leaves the new entry", () => {
    const target: Record<symbol, unknown> = {};
    const offOld = registerProvider(fake(), target);
    const fresh = fake();
    registerProvider(fresh, target);
    offOld();
    expect((target[PR_FACTS_PROVIDER_KEY] as Record<string, unknown>).github).toBe(fresh);
  });

  it("the plugin entry registers on globalThis and its cleanup unregisters", () => {
    const g = globalThis as Record<symbol, unknown>;
    const cleanup = contribute({} as never);
    expect((g[PR_FACTS_PROVIDER_KEY] as Record<string, unknown>).github).toBe(githubProvider);
    cleanup();
    expect((g[PR_FACTS_PROVIDER_KEY] as Record<string, unknown>).github).toBeUndefined();
  });

  it("takes GitHub PR URLs only", () => {
    expect(githubProvider.matches("https://github.com/acme/api/pull/7")).toBe(true);
    expect(githubProvider.matches("https://github.com/acme/api/issues/7")).toBe(false);
    expect(githubProvider.matches("https://gitlab.com/acme/api/-/merge_requests/7")).toBe(false);
  });
});
