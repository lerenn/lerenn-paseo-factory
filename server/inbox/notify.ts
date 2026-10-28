import type { Item } from "./store";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The short mail for a new Inbox item: never the context. */
export function newItemMail(item: Item, askedBy: string): { subject: string; body: string } {
  const options = item.options.map((o) => `${o.label}${o.recommended ? " (recommended)" : ""}`).join(", ");
  const lines = [`Item: ${item.id}`, `Asked by: ${askedBy}`, `Kind: ${item.kind}`];
  if (options) lines.push(`Options: ${clip(options, 200)}`);
  lines.push(`Question: ${clip(oneLine(item.question), 300)}`);
  return { subject: `Inbox ${item.id} new: ${clip(oneLine(item.question), 80)}`, body: lines.join("\n") };
}

/**
 * Decide and send the mail for a new item, once (the flag is persisted). Items the Factory opened for a blueprint
 * gate are skipped while `eventsMailTo` is set: the run's own "waiting" mail already names the item.
 */
export function notifyNewItem(
  item: Item,
  o: { to: string; eventsMailTo: string; askedBy: string; send(to: string, mail: { subject: string; body: string }): Promise<void>; save(): void },
): void {
  if (item.notified || !o.to) return;
  item.notified = true;
  o.save();
  if (item.internal && o.eventsMailTo) return;
  const mail = newItemMail(item, o.askedBy);
  void o.send(o.to, mail).catch((error) => console.error("inbox: new-item mail failed", error));
}
