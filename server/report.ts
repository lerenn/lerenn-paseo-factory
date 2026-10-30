import { Capabilities, mailEndpointFile } from "./capabilities";

export { mailEndpointFile };

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
  /**
   * Without Agents Mail, for an address only Mail resolves (an alias such as `@user`): the report is filed elsewhere (the
   * Factory Inbox, as information) instead of being lost in a direct message to an agent that does not exist.
   */
  fallback?(to: string, report: Report): Promise<void>;
  /** How long a health result (up or down) is reused. */
  ttlMs?: number;
  /** Shared probe; built from `file`, `fetchImpl`, `now` and `ttlMs` when absent. */
  capabilities?: Capabilities;
}

/**
 * Factory reports (information, not questions or tasks) go through Agents Mail when it is installed and answering;
 * otherwise, or if a mail fails, the message is sent directly as before (filed by `fallback` when the address is an alias).
 * No hard dependency.
 */
export function createReporter(opts: Options): (agentId: string, report: Report) => Promise<void> {
  const caps = opts.capabilities ?? new Capabilities({ mailFile: opts.file, fetchImpl: opts.fetchImpl, now: opts.now, ttlMs: opts.ttlMs });
  const doFetch = opts.fetchImpl ?? fetch;

  return async (agentId, report) => {
    const mail = await caps.mailEndpoint();
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
      caps.markMailDown();
    }
    // A mail address (`@user`, `@assistant`, `label:k=v`) is not an agent: only Agents Mail can resolve it. An agent id is
    // messaged directly as before, and its failure still reaches the caller (which may retry, as the Supervisor's digests do).
    if (opts.fallback && isMailAddress(agentId)) return opts.fallback(agentId, report);
    await opts.send(agentId, report.body);
  };
}

/** An address only Agents Mail resolves: an alias (`@assistant`) or a label selector (`label:key=value`). */
export function isMailAddress(to: string): boolean {
  return /^(@|label:)/.test(to.trim());
}
