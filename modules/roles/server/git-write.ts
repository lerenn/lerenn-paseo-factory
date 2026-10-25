import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { roleNameSchema } from "../shared/role";
import type { GitSource } from "../shared/settings";
import { GitSources, redactUrl } from "./git-sync";
import { EXTENSIONS } from "./loader";

export type ChangeAction = "create" | "update" | "delete";

export interface Change {
  name: string;
  /** Role file contents; ignored for delete. */
  text?: string;
  /** Force delete; otherwise create or update is decided by whether the file exists. */
  delete?: boolean;
}

export interface WriteResult {
  /** "pushed": committed on the source's branch. "branch": pushed to a new branch, awaiting a pull request. */
  outcome: "pushed" | "branch";
  action: ChangeAction;
  commit: string;
  branch?: string;
  base: string;
  message: string;
  /** Repository-relative paths touched. */
  files: string[];
  /** Why push mode fell back to a branch. */
  fellBack?: string;
}

export class NothingToCommit extends Error {
  constructor() {
    super("No changes: the file already has this content");
  }
}

const firstLine = (error: unknown) =>
  redactUrl((error as Error).message).split("\n").find((l) => l.trim()) ?? "git failed";

function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "").replace(/[-:T]/g, "");
}

/**
 * Commit a role change into a git source's folder and publish it. Fetches and resets to the
 * latest remote tip first, so the change always sits on top of what is there now. On any failure
 * nothing is kept locally: the edit stays unsaved and the error says why.
 */
export function writeChange(
  sources: GitSources,
  source: GitSource,
  change: Change,
  now: () => Date = () => new Date(),
): Promise<WriteResult> {
  return sources.exclusive(sources.key(source), () => doWrite(sources, source, change, now()));
}

async function doWrite(sources: GitSources, source: GitSource, change: Change, now: Date): Promise<WriteResult> {
  const name = roleNameSchema.parse(change.name);
  const dir = sources.cacheDir(source);
  const git = async (...args: string[]) => ((await sources.git(["-C", dir, ...args])) ?? "") as string;
  if (!existsSync(path.join(dir, ".git"))) throw new Error("This source has not been synced yet; sync it first");

  // The branch the change lands on (push mode) or is proposed against (pull-request mode).
  const base = source.ref || (await defaultBranch(git));
  try {
    await git("ls-remote", "--exit-code", "--heads", "origin", base);
  } catch {
    throw new Error(`"${base}" is not a branch of the repository; set a branch as the source ref to enable writing`);
  }
  try {
    await git("fetch", "--depth", "1", "origin", base);
  } catch (error) {
    throw new Error(`Could not fetch before writing: ${firstLine(error)}`);
  }
  const tip = (await git("rev-parse", "FETCH_HEAD")).trim();
  const reset = async () => {
    await git("checkout", "-q", "-B", "agents-roles-work", tip);
    await git("reset", "-q", "--hard", tip);
    await git("clean", "-fdq");
  };

  try {
    await reset();
    const folder = path.join(dir, source.path ?? "");
    const existing = EXTENSIONS.map((ext) => path.join(folder, name + ext)).find((f) => existsSync(f));
    const action: ChangeAction = change.delete ? "delete" : existing ? "update" : "create";
    if (action === "delete" && !existing) throw new Error(`No role "${name}" in this git source`);
    const target = existing ?? path.join(folder, `${name}.yaml`);
    const relative = path.relative(dir, target).split(path.sep).join("/");

    if (action === "delete") {
      await git("rm", "-q", "--", relative);
    } else {
      if (existing && (await readFile(existing, "utf8")) === ensureNewline(change.text ?? "")) throw new NothingToCommit();
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, ensureNewline(change.text ?? ""));
      await git("add", "--", relative);
    }
    if (!(await git("diff", "--cached", "--name-only")).trim()) throw new NothingToCommit();

    const message = `agents-roles: ${action} ${name}`;
    const identity = await commitIdentity(git);
    await git(...identity, "commit", "-q", "-m", message);
    const commit = (await git("rev-parse", "HEAD")).trim();
    const common = { action, commit, base, message, files: [relative] };

    const pushBranch = async () => {
      const branch = `agents-roles/${name}-${stamp(now)}`;
      await git("push", "origin", `HEAD:refs/heads/${branch}`);
      return branch;
    };
    let result: WriteResult;
    if (source.writeMode === "push") {
      try {
        await git("push", "origin", `HEAD:refs/heads/${base}`);
        result = { ...common, outcome: "pushed" };
      } catch (error) {
        const reason = firstLine(error);
        result = { ...common, outcome: "branch", branch: await pushBranch(), fellBack: reason };
      }
    } else {
      result = { ...common, outcome: "branch", branch: await pushBranch() };
    }
    // A proposed branch must not leak into the local view of the source until it is merged.
    if (result.outcome === "branch") await reset();
    return result;
  } catch (error) {
    await reset().catch(() => undefined);
    if (error instanceof NothingToCommit) throw error;
    throw new Error(firstLine(error));
  }
}

const ensureNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

async function defaultBranch(git: (...args: string[]) => Promise<string>): Promise<string> {
  const out = await git("ls-remote", "--symref", "origin", "HEAD");
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out);
  if (!match) throw new Error("Could not determine the repository's default branch; set a branch as the source ref");
  return match[1];
}

/** Use the daemon's git identity when it has one, a neutral one otherwise. */
async function commitIdentity(git: (...args: string[]) => Promise<string>): Promise<string[]> {
  const get = (key: string) => git("config", "--get", key).then((v) => v.trim(), () => "");
  const [user, email] = await Promise.all([get("user.name"), get("user.email")]);
  return [
    ...(user ? [] : ["-c", "user.name=Paseo agents-roles"]),
    ...(email ? [] : ["-c", "user.email=agents-roles@paseo.invalid"]),
  ];
}
