import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/**
 * Tests never touch the real host: HOME and every endpoint the plugin reads (Agents Mail, the Factory, Events, the Paseo
 * daemon) point into a private temp folder, and `fetch` refuses the endpoints of the real host and anything that is not
 * loopback. A test that needs a server starts its own on 127.0.0.1.
 */
const realHome = process.env.FACTORY_TEST_REAL_HOME ?? homedir();
const home = mkdtempSync(path.join(tmpdir(), "factory-test-home-"));

const realEndpoints: string[] = [];
for (const file of ["agents-mail/endpoint.json", "factory/endpoint.json", "agents-events/endpoint.json", "events/endpoint.json"]) {
  try {
    const p = path.join(realHome, ".paseo", file);
    if (existsSync(p)) {
      const url = (JSON.parse(readFileSync(p, "utf8")) as { url?: string }).url;
      if (url) realEndpoints.push(new URL(url).host);
    }
  } catch {
    // unreadable: nothing to protect
  }
}

process.env.FACTORY_TEST_REAL_HOME = realHome;
process.env.FACTORY_TEST_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.PASEO_HOME = path.join(home, ".paseo");
process.env.FACTORY_DATA = path.join(home, "data");
process.env.FACTORY_ENDPOINT = path.join(home, "factory-endpoint.json");
process.env.FACTORY_MAIL_ENDPOINT = path.join(home, "mail-endpoint.json");
process.env.FACTORY_EVENTS_ENDPOINT = path.join(home, "events-endpoint.json");
process.env.FACTORY_PASEO_ENDPOINT = path.join(home, "paseo-endpoint.json");
process.env.PASEO_ENDPOINT = path.join(home, "paseo-endpoint.json");
process.env.PASEO_LISTEN = "127.0.0.1:0";
for (const key of ["INBOX_STATE", "BLUEPRINTS_STATE", "BLUEPRINTS_SPEND", "LEASES_STATE", "SUPERVISOR_STATE", "WARDEN_STATE", "WARDER_STATE", "FACTORY_BLUEPRINTS_DIR"]) delete process.env[key];

const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const url = new URL(raw);
  if (realEndpoints.includes(url.host)) throw new Error(`test isolation: refusing a request to the real host endpoint ${url.host}`);
  if (!loopback.has(url.hostname)) throw new Error(`test isolation: refusing a request to ${url.host} (only loopback is allowed in tests)`);
  return realFetch(input as never, init);
}) as typeof fetch;
