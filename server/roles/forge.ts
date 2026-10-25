export type PullRequestState = "open" | "closed" | "merged";

export interface PullRequest {
  number: number;
  url: string;
  state: PullRequestState;
}

export interface RepoRef {
  owner: string;
  name: string;
}

export interface PullRequestDraft {
  title: string;
  body: string;
  /** Branch the change should land on. */
  base: string;
  /** Branch holding the change. */
  head: string;
}

/**
 * A code forge that can open and read pull requests. GitHub is implemented below; to support
 * another forge, implement this interface and add it to `forges`.
 */
export interface Forge {
  id: string;
  /** The repository a clone URL points at on this forge, or null when it is not this forge's. */
  parse(url: string): RepoRef | null;
  /** Web URL that opens a prefilled "new pull request" page; needs no token. */
  compareUrl(repo: RepoRef, draft: PullRequestDraft): string;
  createPullRequest(repo: RepoRef, token: string, draft: PullRequestDraft): Promise<PullRequest>;
  getPullRequest(repo: RepoRef, token: string, number: number): Promise<PullRequest>;
}

type Fetch = typeof fetch;

/** Pull-request prefill is passed in the URL; keep it under typical URL length limits. */
const MAX_PREFILL_BODY = 3000;

export function createGitHubForge(fetchImpl: Fetch = fetch): Forge {
  async function call(token: string, method: string, path: string, body?: unknown) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "paseo-agents-roles",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const detail = typeof json.message === "string" ? json.message : response.statusText;
      const hint = response.status === 401 || response.status === 403 || response.status === 404
        ? " (check that the token has pull request write access to this repository)"
        : "";
      throw new Error(`GitHub ${response.status}: ${detail}${hint}`);
    }
    return json;
  }

  function toPullRequest(json: Record<string, unknown>): PullRequest {
    const state = json.merged === true || json.merged_at ? "merged" : json.state === "closed" ? "closed" : "open";
    return { number: json.number as number, url: json.html_url as string, state };
  }

  return {
    id: "github",
    parse(url) {
      const match =
        /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/(?:[^/@]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
          url.trim(),
        );
      return match ? { owner: match[1], name: match[2] } : null;
    },
    compareUrl(repo, draft) {
      const query = new URLSearchParams({
        expand: "1",
        title: draft.title,
        body: draft.body.slice(0, MAX_PREFILL_BODY),
      });
      const range = `${encodeURIComponent(draft.base)}...${encodeURIComponent(draft.head)}`;
      return `https://github.com/${repo.owner}/${repo.name}/compare/${range}?${query}`;
    },
    async createPullRequest(repo, token, draft) {
      const json = await call(token, "POST", `/repos/${repo.owner}/${repo.name}/pulls`, {
        title: draft.title,
        body: draft.body,
        head: draft.head,
        base: draft.base,
      });
      return toPullRequest(json);
    },
    async getPullRequest(repo, token, number) {
      return toPullRequest(await call(token, "GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`));
    },
  };
}

export const forges: Forge[] = [createGitHubForge()];

export function forgeFor(url: string, list: Forge[] = forges): { forge: Forge; repo: RepoRef } | null {
  for (const forge of list) {
    const repo = forge.parse(url);
    if (repo) return { forge, repo };
  }
  return null;
}
