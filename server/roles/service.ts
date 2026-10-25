import { roleNameSchema } from "../../shared/roles/role";
import type { GitStatus, Proposal } from "../../shared/roles/rpc";
import type { GitSource } from "../../shared/roles/settings";
import { listRoles } from "./catalog";
import { forgeFor, type Forge } from "./forge";
import { type Change, type WriteResult, writeChange } from "./git-write";
import { GitSources, sourceLabel } from "./git-sync";
import { describeError, parseRoleText } from "./loader";
import type { ProposalStore } from "./proposals";
import { scrub, type TokenStore } from "./tokens";

export interface ServiceDeps {
  sources: GitSources;
  tokens: TokenStore;
  proposals: ProposalStore;
  /** Configured git sources, read fresh on each call. */
  configured(): Promise<GitSource[]>;
  forges?: Forge[];
}

/** Writes role changes to git sources and tracks the resulting branches and pull requests. */
export class RolesService {
  constructor(private readonly deps: ServiceDeps) {}

  id(source: GitSource): string {
    return this.deps.sources.key(source);
  }

  async find(sourceId: string): Promise<GitSource> {
    const found = (await this.deps.configured()).find((s) => this.id(s) === sourceId);
    if (!found) throw new Error("That git source is no longer configured");
    return found;
  }

  statuses(sources: GitSource[]): GitStatus[] {
    return sources.map((s) => ({
      id: this.id(s),
      label: sourceLabel(s),
      url: s.url,
      ref: s.ref,
      path: s.path,
      writeMode: s.writeMode,
      forge: forgeFor(s.url, this.deps.forges)?.forge.id ?? null,
      hasToken: this.deps.tokens.has(this.id(s)),
      ...this.deps.sources.status(s),
    }));
  }

  /** Roles from the configured git sources. */
  async list() {
    const sources = await this.deps.configured();
    return listRoles(
      sources.map((s) => ({ id: this.id(s), label: sourceLabel(s), dir: this.deps.sources.rolesDir(s) })),
    );
  }

  async save(sourceId: string, text: string): Promise<Proposal> {
    const source = await this.find(sourceId);
    let role;
    try {
      role = parseRoleText(text);
    } catch (error) {
      throw new Error(describeError(error));
    }
    const result = await this.write(source, { name: role.name, text });
    return this.record(source, role.name, result);
  }

  async remove(sourceId: string, name: string): Promise<Proposal> {
    const source = await this.find(sourceId);
    const result = await this.write(source, { name: roleNameSchema.parse(name), delete: true });
    return this.record(source, name, result);
  }

  private async write(source: GitSource, change: Change): Promise<WriteResult> {
    try {
      return await writeChange(this.deps.sources, source, change);
    } catch (error) {
      const reason = (error as Error).message.replace(/\.$/, "");
      const hint = source.writeMode === "push" ? " Consider switching this source to pull-request mode." : "";
      throw new Error(`Not saved: ${reason}.${hint}`);
    }
  }

  private record(source: GitSource, role: string, result: WriteResult): Proposal {
    const title = result.message;
    const body = [
      "Proposed from the Paseo Agent Roles plugin.",
      "",
      "Changed files:",
      ...result.files.map((f) => `- ${f} (${result.action === "create" ? "added" : result.action === "delete" ? "removed" : "modified"})`),
    ].join("\n");
    const found = forgeFor(source.url, this.deps.forges);
    const compareUrl =
      result.outcome === "branch" && found && result.branch
        ? found.forge.compareUrl(found.repo, { title, body, base: result.base, head: result.branch })
        : undefined;
    return this.deps.proposals.add({
      sourceId: this.id(source),
      sourceLabel: sourceLabel(source),
      role,
      action: result.action,
      outcome: result.outcome,
      commit: result.commit,
      branch: result.branch,
      base: result.base,
      title,
      body,
      files: result.files,
      compareUrl,
      fellBack: result.fellBack,
    });
  }

  /** Open the pull request for a pushed branch through the forge API. */
  async createPullRequest(id: string): Promise<Proposal> {
    const proposal = this.deps.proposals.get(id);
    if (!proposal) throw new Error("Unknown proposal");
    if (proposal.pr) return proposal;
    if (proposal.outcome !== "branch" || !proposal.branch) throw new Error("This change was pushed directly; there is no branch to propose");
    const source = await this.find(proposal.sourceId);
    const found = forgeFor(source.url, this.deps.forges);
    const token = this.deps.tokens.get(proposal.sourceId);
    if (!found) throw new Error("This repository's forge is not supported; open the compare page instead");
    if (!token) throw new Error("No forge token is set for this source; open the compare page instead");
    try {
      const pr = await found.forge.createPullRequest(found.repo, token, {
        title: proposal.title,
        body: proposal.body,
        base: proposal.base,
        head: proposal.branch,
      });
      return this.deps.proposals.update(id, { pr, prError: undefined })!;
    } catch (error) {
      const message = scrub((error as Error).message, token);
      this.deps.proposals.update(id, { prError: message });
      throw new Error(message);
    }
  }

  /** All proposals, with the state of open pull requests refreshed when a token allows it. */
  async proposals(): Promise<Proposal[]> {
    const sources = await this.deps.configured();
    for (const p of this.deps.proposals.list()) {
      if (!p.pr || p.pr.state !== "open") continue;
      const source = sources.find((s) => this.id(s) === p.sourceId);
      const token = this.deps.tokens.get(p.sourceId);
      const found = source && forgeFor(source.url, this.deps.forges);
      if (!found || !token) continue;
      try {
        const pr = await found.forge.getPullRequest(found.repo, token, p.pr.number);
        this.deps.proposals.update(p.id, { pr });
      } catch {
        // keep the last known state; the next refresh retries
      }
    }
    return this.deps.proposals.list();
  }
}
