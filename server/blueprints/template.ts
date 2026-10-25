/** `{{name}}` placeholders. Unknown names are an error, so a typo in a blueprint fails loudly. */
export function render(template: string, lookup: (name: string) => string | undefined): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g, (_m, name: string) => {
    const value = lookup(name);
    if (value === undefined) throw new Error(`unknown variable {{${name}}}`);
    return value;
  });
}

/** `a == b`, `a != b`, or a bare value that must be `true`. */
export function condition(rendered: string): boolean {
  const eq = /^(.*?)\s*(==|!=)\s*(.*)$/s.exec(rendered.trim());
  if (!eq) return rendered.trim().toLowerCase() === "true";
  const same = eq[1].trim() === eq[3].trim();
  return eq[2] === "==" ? same : !same;
}
