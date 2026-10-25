import { parseDocument } from "yaml";

/** Top-level scalar fields of a role file that the editor's dropdowns control. */
export type LaunchField = "provider" | "model" | "thinkingOptionId" | "modeId";

/** Read a top-level scalar from role text; undefined when absent or the text does not parse. */
export function readField(text: string, field: LaunchField): string | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length) return undefined;
  const value = doc.get(field);
  return typeof value === "string" ? value : undefined;
}

/**
 * Set (or, with undefined, remove) a top-level scalar in role text, keeping the rest of the
 * file, comments included. Text that does not parse is returned unchanged.
 */
export function writeField(text: string, field: LaunchField, value: string | undefined): string {
  const doc = parseDocument(text);
  if (doc.errors.length || !doc.contents) return text;
  if (value === undefined || value === "") doc.delete(field);
  else doc.set(field, value);
  return doc.toString();
}
