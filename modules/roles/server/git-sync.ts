import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitSource as ConfiguredSource } from "../shared/settings";

/** What syncing needs to know about a source. */
type GitSource = Pick<ConfiguredSource, "url" | "ref" | "path" | "intervalMinutes">;

const execFileAsync = promisify(execFile);

export const gitCacheRoot = path.join(homedir(), ".paseo", "agents-roles", "git");

export interface SyncStatus {
  lastSync: string | null;
  error: string | null;
  syncing: boolean;
}

/** Runs `git <args>` and returns stdout; rejects with the failure message. Injectable for tests. */
export type GitRunner = (args: string[]) => Promise<string | void>;

/** The URL without any user:password@ part, for display and error messages. */
export function redactUrl(text: string): string {
  return text.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1");
}

/**
 * Short display form of a source: `owner/repo@ref` on GitHub, `host/owner/repo@ref` elsewhere.
 * Understands ssh (`git@host:owner/repo.git`, `ssh://...`) and https URLs; anything else (a local
 * path, say) is shown as given, without credentials.
 */
export function sourceLabel(source: Pick<GitSource, "url" | "ref">): string {
  return `${repoLabel(source.url)}@${source.ref || "HEAD"}`;
}

function repoLabel(rawUrl: string): string {
  const url = rawUrl.trim();
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+?)\/?$/i.exec(url) ??
    /^(?:[^/@\s]+@)?([^/:\s]+):(?!\/)(.+?)\/?$/.exec(url);
  if (!match) return redactUrl(url);
  const host = match[1].toLowerCase();
  const repo = match[2].replace(/\.git$/, "");
  return host === "github.com" ? repo : `${host}/${repo}`;
}

export const runGit = async (args: string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      timeout: 120_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
      },
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    const detail = (e.stderr?.trim() || e.message).split("\n").filter(Boolean).slice(-2).join(" ");
    throw new Error(redactUrl(detail).slice(0, 300));
  }
};

/**
 * Keeps shallow clones of the configured git sources under `root` and re-fetches them on an
 * interval. A failed sync records the error and leaves the previous copy in place.
 */
export class GitSources {
  private readonly statuses = new Map<string, SyncStatus>();
  private readonly inflight = new Map<string, Promise<SyncStatus>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly root: string = gitCacheRoot,
    readonly git: GitRunner = runGit,
    private readonly now: () => Date = () => new Date(),
  ) {}

  key(source: GitSource): string {
    return createHash("sha256").update(`${source.url}\0${source.ref ?? ""}`).digest("hex").slice(0, 16);
  }

  cacheDir(source: GitSource): string {
    return path.join(this.root, this.key(source));
  }

  /** Directory holding the role files of `source` (its folder inside the clone). */
  rolesDir(source: GitSource): string {
    return path.join(this.cacheDir(source), source.path ?? "");
  }

  status(source: GitSource): SyncStatus {
    const known = this.statuses.get(this.key(source));
    if (known) return known;
    // A copy from an earlier daemon run is usable even before the first sync of this run.
    return { lastSync: null, error: null, syncing: false };
  }

  /** Sync one source now. Concurrent calls for the same source share one run. */
  sync(source: GitSource): Promise<SyncStatus> {
    const key = this.key(source);
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.exclusive(key, () => this.doSync(source, key)).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Run `fn` after every earlier exclusive task for the same source, so a sync never races a write. */
  exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.locks.set(key, result);
    return result;
  }

  private async doSync(source: GitSource, key: string): Promise<SyncStatus> {
    const previous = this.status(source);
    this.statuses.set(key, { ...previous, syncing: true });
    const dir = this.cacheDir(source);
    try {
      if (source.url.startsWith("-") || source.ref?.startsWith("-")) throw new Error("invalid source");
      await mkdir(this.root, { recursive: true });
      if (existsSync(path.join(dir, ".git"))) {
        await this.git(["-C", dir, "fetch", "--depth", "1", "origin", source.ref || "HEAD"]);
        await this.git(["-C", dir, "reset", "--hard", "FETCH_HEAD"]);
      } else {
        const tmp = `${dir}.tmp`;
        await rm(tmp, { recursive: true, force: true });
        const branch = source.ref ? ["--branch", source.ref] : [];
        await this.git(["clone", "--depth", "1", "--single-branch", ...branch, "--", source.url, tmp]);
        await rm(dir, { recursive: true, force: true });
        await rename(tmp, dir);
      }
      const ok = { lastSync: this.now().toISOString(), error: null, syncing: false };
      this.statuses.set(key, ok);
      return ok;
    } catch (error) {
      const failed = { ...previous, error: redactUrl((error as Error).message), syncing: false };
      this.statuses.set(key, failed);
      return failed;
    }
  }

  async syncAll(sources: GitSource[]): Promise<void> {
    await Promise.all(sources.map((source) => this.sync(source)));
  }

  /** Replace the schedule: sync every source now, then every `intervalMinutes`. */
  configure(sources: GitSource[]): void {
    this.stop();
    for (const source of sources) {
      void this.sync(source);
      const timer = setInterval(() => void this.sync(source), source.intervalMinutes * 60_000);
      (timer as { unref?: () => void }).unref?.();
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
