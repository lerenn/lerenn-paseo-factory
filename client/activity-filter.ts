import type { ActivityEntry } from "../shared/rpc";

/** Pure filter, exported for tests. Empty selections mean "all". */
export function filterActivity(items: ActivityEntry[], f: { types: string[]; blueprint: string | null; role: string | null }): ActivityEntry[] {
  return items.filter((i) => (f.types.length === 0 || f.types.includes(i.type)) && (!f.blueprint || i.blueprint === f.blueprint) && (!f.role || i.role === f.role));
}
