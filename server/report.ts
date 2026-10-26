import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const mailEndpointFile = () => process.env.FACTORY_MAIL_ENDPOINT ?? path.join(homedir(), ".paseo", "agents-mail", "endpoint.json");

export interface Report {
  subject: string;
  /** Plain text; also what the fallback sends to the agent. */
  body: string;
  /** Free tag (Agents Mail accepts up to 32 characters): digest | run | notice. */
  kind: string;
}

interface Options {
  file?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The path Agents Mail replaces: steer the agent directly. */
  send(agentId: string, text: string): Promise<void>;
  /** How long a health result (up or down) is reused. */
  ttlMs?: number;
}

/**
 * Factory reports (information, not questions or tasks) go through Agents Mail when it is installed and answering;
 * otherwise, or if a mail fails, the message is sent directly as before. No hard dependency.
 */
export function createReporter(opts: Options): (agentId: string, report: Report) => Promise<void> {
  const file = opts.file ?? mailEndpointFile;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 60_000;
  let cached: { at: number; endpoint: { url: string; token: string } | null } | null = null;

  async function endpoint(): Promise<{ url: string; token: string } | null> {
    if (cached && now() - cached.at < ttl) return cached.endpoint;
    let found: { url: string; token: string } | null = null;
    try {
      const raw = JSON.parse(readFileSync(file(), "utf8")) as { url?: string; token?: string };
      if (raw.url && raw.token) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 2000);
        const res = await doFetch(`${raw.url.replace(/\/$/, "")}/api/health`, { headers: { authorization: `Bearer ${raw.token}` }, signal: abort.signal }).finally(() => clearTimeout(timer));
        if (res.ok) found = { url: raw.url.replace(/\/$/, ""), token: raw.token };
      }
    } catch {
      found = null;
    }
    cached = { at: now(), endpoint: found };
    return found;
  }

  return async (agentId, report) => {
    const mail = await endpoint();
    if (mail) {
      try {
        const res = await doFetch(`${mail.url}/api/mails`, {
          method: "POST",
          headers: { authorization: `Bearer ${mail.token}`, "content-type": "application/json" },
          body: JSON.stringify({ to: agentId, subject: report.subject.slice(0, 200), body: report.body, kind: report.kind.slice(0, 32), asAgent: { agentId: "factory", name: "Factory" } }),
        });
        if (res.ok) return;
      } catch {
        // fall through to the direct path
      }
      cached = { at: now(), endpoint: null };
    }
    await opts.send(agentId, report.body);
  };
}
