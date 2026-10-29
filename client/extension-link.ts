import type { ExtensionLink } from "./registry";

/** Where an extension tab's `open(link)` goes: a Factory tab with the run or item to show, or an outside URL. */
export type LinkTarget = { tab: "blueprints" | "inbox"; focus: string } | { url: string } | null;

/** Validate a link from an extension: only Blueprints runs, Inbox items and http(s) URLs; anything else is ignored. */
export function resolveLink(link: ExtensionLink | null | undefined): LinkTarget {
  if (!link || typeof link !== "object") return null;
  if ("url" in link) return typeof link.url === "string" && /^https?:\/\//i.test(link.url) ? { url: link.url } : null;
  if (link.tab === "blueprints" && typeof link.runId === "string" && link.runId) return { tab: "blueprints", focus: link.runId };
  if (link.tab === "inbox" && typeof link.itemId === "string" && link.itemId) return { tab: "inbox", focus: link.itemId };
  return null;
}
