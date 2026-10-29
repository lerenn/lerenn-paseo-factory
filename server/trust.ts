/** Labels ("key=value") that mark a trusted agent (factory setting `trustedLabels`). */
let current: { key: string; value: string }[] = [];

export function parseTrustedLabels(list: readonly string[]): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of list) {
    const entry = raw.trim();
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out.push({ key: entry.slice(0, eq).trim(), value: entry.slice(eq + 1).trim() });
  }
  return out;
}

export function setTrustedLabels(list: readonly string[]): void {
  current = parseTrustedLabels(list);
}

export function getTrustedLabels(): string[] {
  return current.map((l) => `${l.key}=${l.value}`);
}

/** An agent carrying at least one trusted label. */
export function isTrusted(labels: Record<string, string> | undefined | null): boolean {
  if (!labels) return false;
  return current.some((l) => labels[l.key] === l.value);
}
