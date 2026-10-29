import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { endpointFile } from "./host";
import { mailEndpointFile } from "./report";
import { defaultRegistryPath } from "./roles/limits";
import { defaultProposalsPath } from "./roles/proposals";
import { defaultTokensPath } from "./roles/tokens";
import { gitCacheRoot } from "./roles/git-sync";

const home = process.env.FACTORY_TEST_HOME!;
const realHome = process.env.FACTORY_TEST_REAL_HOME!;

describe("test isolation", () => {
  it("runs with a private HOME, not the real one", () => {
    expect(home).toBeTruthy();
    expect(realHome).toBeTruthy();
    expect(home).not.toBe(realHome);
    expect(homedir()).toBe(home);
  });

  it("resolves every default endpoint and state path inside the private HOME", () => {
    const inside = (p: string) => expect(path.resolve(p).startsWith(home + path.sep)).toBe(true);
    for (const p of [endpointFile(), mailEndpointFile(), defaultRegistryPath, defaultProposalsPath, defaultTokensPath, gitCacheRoot]) inside(p);
  });

  it("sets the endpoint overrides to the private folder", () => {
    for (const key of ["FACTORY_ENDPOINT", "FACTORY_MAIL_ENDPOINT", "FACTORY_EVENTS_ENDPOINT", "FACTORY_PASEO_ENDPOINT", "PASEO_ENDPOINT"]) {
      expect(process.env[key]?.startsWith(home + path.sep), key).toBe(true);
    }
  });

  it("refuses requests that leave the machine", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/test isolation/);
    await expect(fetch("http://10.0.0.5:8080/api/health")).rejects.toThrow(/test isolation/);
  });
});
