import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Proposal } from "../shared/rpc";

export const defaultProposalsPath = path.join(homedir(), ".paseo", "agents-roles", "proposals.json");
const MAX_KEPT = 50;

/** Recent changes written to git sources, so the UI can show their commit, branch and pull request. */
export class ProposalStore {
  constructor(private readonly file: string = defaultProposalsPath) {}

  list(): Proposal[] {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  private save(proposals: Proposal[]) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(proposals.slice(0, MAX_KEPT), null, 2));
  }

  add(proposal: Omit<Proposal, "id" | "createdAt">, now: Date = new Date()): Proposal {
    const created = { ...proposal, id: randomUUID(), createdAt: now.toISOString() };
    this.save([created, ...this.list()]);
    return created;
  }

  get(id: string): Proposal | undefined {
    return this.list().find((p) => p.id === id);
  }

  update(id: string, patch: Partial<Proposal>): Proposal | undefined {
    let updated: Proposal | undefined;
    this.save(
      this.list().map((p) => (p.id === id ? (updated = { ...p, ...patch }) : p)),
    );
    return updated;
  }
}
