import { execFile } from "node:child_process";
import type { PrFacts } from "./engine";

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** Reduce the check runs and statuses of a PR to one word. */
export function rollup(checks: { conclusion?: string | null; status?: string | null; state?: string | null }[]): PrFacts["ci"] {
  if (checks.length === 0) return "none";
  let pending = false;
  for (const c of checks) {
    const verdict = (c.conclusion || c.state || "").toUpperCase();
    const status = (c.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(verdict)) return "red";
    if ((status && status !== "COMPLETED") || ["PENDING", "EXPECTED", ""].includes(verdict)) pending = true;
  }
  return pending ? "pending" : "green";
}

/** Facts about a PR from GitHub itself (through `gh`, which the pod routes to the GitHub proxy). */
export async function ghFacts(url: string): Promise<PrFacts> {
  if (!PR_URL.test(url)) throw new Error(`not a GitHub pull request URL: ${url}`);
  let out: string;
  try {
    out = await run("gh", ["pr", "view", url, "--json", "state,headRefOid,mergeable,statusCheckRollup,reviewDecision,isDraft"]);
  } catch (error) {
    if (/Could not resolve|not found|404/i.test((error as Error).message)) {
      return { url, exists: false, state: "closed", head: "", ci: "none", mergeable: null, draft: false, review: "" };
    }
    throw error;
  }
  const j = JSON.parse(out);
  return {
    url,
    exists: true,
    state: String(j.state).toLowerCase() === "merged" ? "merged" : String(j.state).toLowerCase() === "closed" ? "closed" : "open",
    head: j.headRefOid ?? "",
    ci: rollup(j.statusCheckRollup ?? []),
    mergeable: j.mergeable === "MERGEABLE" ? true : j.mergeable === "CONFLICTING" ? false : null,
    draft: !!j.isDraft,
    review: j.reviewDecision ?? "",
  };
}
