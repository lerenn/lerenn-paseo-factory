import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const tmp = () => mkdtemp(path.join(tmpdir(), "roles-test-"));

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString();

/** A bare origin with roles/ev.yaml on branch main, plus a working clone for making upstream changes. */
export async function makeOrigin(model = "v1") {
  const bare = await tmp();
  git(bare, "init", "-q", "--bare", "-b", "main");
  const work = await tmp();
  git(work, "clone", "-q", bare, ".");
  git(work, "checkout", "-q", "-b", "main");
  await mkdir(path.join(work, "roles"));
  await writeFile(path.join(work, "roles", "ev.yaml"), `name: ev\nmodel: ${model}\n`);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  return {
    bare,
    work,
    /** Commit a file upstream (as another contributor would). */
    async upstream(file: string, content: string) {
      git(work, "pull", "-q", "origin", "main");
      await writeFile(path.join(work, file), content);
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", `upstream ${file}`);
      git(work, "push", "-q", "origin", "main");
    },
    /** Make the origin reject pushes to main, like branch protection. */
    protectMain() {
      const hook = path.join(bare, "hooks", "pre-receive");
      execFileSync("sh", ["-c", `printf '#!/bin/sh\\nwhile read o n ref; do [ "$ref" = refs/heads/main ] && { echo "protected branch" >&2; exit 1; }; done\\nexit 0\\n' > '${hook}'`]);
      chmodSync(hook, 0o755);
    },
  };
}
