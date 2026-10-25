import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_SYNC_MINUTES = 5;

/** A git repository whose folder of role files is mirrored read-only. */
export const gitSourceSchema = z.object({
  /** Anything `git clone` accepts. Credentials come from the daemon's git/SSH setup, not from here. */
  url: z
    .string()
    .trim()
    .min(1)
    .refine((v) => !v.startsWith("-"), "url must not start with '-'"),
  /** Branch or tag. Omit for the remote's default branch. */
  ref: z
    .string()
    .trim()
    .refine((v) => !v.startsWith("-"), "ref must not start with '-'")
    .optional(),
  /** Folder inside the repository that holds the role files. Omit for the repository root. */
  path: z
    .string()
    .trim()
    .refine((v) => !v.split(/[\\/]/).includes(".."), "path must stay inside the repository")
    .refine((v) => !/^([\\/]|[A-Za-z]:)/.test(v), "path must be relative")
    .optional(),
  intervalMinutes: z.number().int().min(1).default(DEFAULT_SYNC_MINUTES),
  /**
   * How saved role changes reach the repository. "pull-request" pushes a branch for review;
   * "push" commits straight to the ref and falls back to a branch if the push is rejected.
   */
  writeMode: z.enum(["pull-request", "push"]).default("pull-request"),
});
export type GitSource = z.output<typeof gitSourceSchema>;

export const rolesSettings = defineSettings({
  id: "roles",
  scope: "host",
  version: 1,
  schema: z.object({ sources: z.array(gitSourceSchema).default([]) }),
});
