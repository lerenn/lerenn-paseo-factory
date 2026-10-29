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
export function rollup(checks: Check[]): PrFacts["ci"] {
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

type Check = { conclusion?: string | null; status?: string | null; state?: string | null };

/**
 * CI of a head without the Checks API (a fine-grained token cannot hold that permission and gets a 403): the commit statuses plus the
 * latest Actions run of each workflow on that commit.
 */
async function ciWithoutChecksApi(owner: string, repo: string, head: string): Promise<PrFacts["ci"]> {
  const [status, runs] = await Promise.all([
    run("gh", ["api", `repos/${owner}/${repo}/commits/${head}/status`]),
    run("gh", ["api", `repos/${owner}/${repo}/actions/runs?head_sha=${head}&per_page=100`]),
  ]);
  const checks: Check[] = (JSON.parse(status).statuses ?? []).map((x: { state: string }) => ({ state: x.state }));
  const latest = new Map<number, { id: number; status: string; conclusion: string | null }>();
  for (const r of JSON.parse(runs).workflow_runs ?? []) {
    const seen = latest.get(r.workflow_id);
    if (!seen || r.id > seen.id) latest.set(r.workflow_id, r);
  }
  for (const r of latest.values()) checks.push({ status: r.status, conclusion: r.conclusion });
  return rollup(checks);
}

/**
 * The PR's place in a merge queue. Once GitHub moves an auto-merge PR into the queue it can drop `autoMergeRequest`, so that field
 * alone read a queued PR as "left the queue" and re-opened the merge gate (ANY-2740: three times in 35 min). Position and ETA feed
 * the wait-queue status (ANY-2738). Empty when GitHub does not say.
 */
async function mergeQueue(owner: string, repo: string, number: string): Promise<{ inQueue?: boolean; position?: number; etaSeconds?: number }> {
  try {
    const out = await run("gh", [
      "api", "graphql",
      "-f", "query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){isInMergeQueue mergeQueueEntry{position estimatedTimeToMerge}}}}",
      "-f", `o=${owner}`, "-f", `r=${repo}`, "-F", `n=${number}`,
    ]);
    const pr = JSON.parse(out).data?.repository?.pullRequest;
    const entry = pr?.mergeQueueEntry;
    return {
      inQueue: typeof pr?.isInMergeQueue === "boolean" ? pr.isInMergeQueue : undefined,
      position: typeof entry?.position === "number" ? entry.position : undefined,
      etaSeconds: typeof entry?.estimatedTimeToMerge === "number" ? entry.estimatedTimeToMerge : undefined,
    };
  } catch {
    return {};
  }
}

/** Facts about a PR from GitHub itself (through the daemon's own `gh` login; the agents' GitHub access is the GitHub MCP server). */
export async function ghFacts(url: string): Promise<PrFacts> {
  const match = PR_URL.exec(url);
  if (!match) throw new Error(`not a GitHub pull request URL: ${url}`);
  let out: string;
  let rolledUp = true;
  try {
    try {
      out = await run("gh", ["pr", "view", url, "--json", "state,headRefOid,mergeable,statusCheckRollup,reviewDecision,isDraft,autoMergeRequest"]);
    } catch (error) {
      if (!/403|Resource not accessible/i.test((error as Error).message)) throw error;
      rolledUp = false;
      out = await run("gh", ["pr", "view", url, "--json", "state,headRefOid,mergeable,reviewDecision,isDraft,autoMergeRequest"]);
    }
  } catch (error) {
    if (/Could not resolve|not found|404/i.test((error as Error).message)) {
      return { url, exists: false, state: "closed", head: "", ci: "none", mergeable: null, draft: false, review: "" };
    }
    throw error;
  }
  const j = JSON.parse(out);
  const state = String(j.state).toLowerCase() === "merged" ? "merged" : String(j.state).toLowerCase() === "closed" ? "closed" : "open";
  const autoMerge = j.autoMergeRequest !== null && j.autoMergeRequest !== undefined;
  const q = state === "open" ? await mergeQueue(match[1], match[2], match[3]) : {};
  const queued = autoMerge || q.inQueue === true ? true : state !== "open" ? false : q.inQueue;
  return {
    url,
    exists: true,
    state,
    head: j.headRefOid ?? "",
    ci: rolledUp ? rollup(j.statusCheckRollup ?? []) : await ciWithoutChecksApi(match[1], match[2], j.headRefOid ?? ""),
    mergeable: j.mergeable === "MERGEABLE" ? true : j.mergeable === "CONFLICTING" ? false : null,
    draft: !!j.isDraft,
    review: j.reviewDecision ?? "",
    queued,
    ...(q.position !== undefined ? { queuePosition: q.position } : {}),
    ...(q.etaSeconds !== undefined ? { queueEtaSeconds: q.etaSeconds } : {}),
  };
}

export interface DiffSummary {
  files: number;
  additions: number;
  deletions: number;
}

/** Files changed and lines added or removed, from GitHub. */
export async function ghDiff(url: string): Promise<DiffSummary> {
  if (!PR_URL.test(url)) throw new Error(`not a GitHub pull request URL: ${url}`);
  const j = JSON.parse(await run("gh", ["pr", "view", url, "--json", "changedFiles,additions,deletions"]));
  return { files: j.changedFiles ?? 0, additions: j.additions ?? 0, deletions: j.deletions ?? 0 };
}
