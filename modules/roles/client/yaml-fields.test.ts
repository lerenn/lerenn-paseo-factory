import { describe, expect, it } from "vitest";
import { readField, writeField } from "./yaml-fields";

const TEXT = `# my role
name: r
description: "A: colon"
model: old
systemPrompt: |
  Keep this
  prompt.
`;

describe("yaml fields", () => {
  it("reads a top-level scalar", () => {
    expect(readField(TEXT, "model")).toBe("old");
    expect(readField(TEXT, "provider")).toBeUndefined();
    expect(readField("name: [unclosed", "model")).toBeUndefined();
  });

  it("sets and replaces a field, keeping comments and the prompt block", () => {
    const out = writeField(writeField(TEXT, "provider", "claude"), "model", "new");
    expect(out).toContain("# my role");
    expect(out).toContain("provider: claude");
    expect(out).toContain("model: new");
    expect(out).toContain("systemPrompt: |\n  Keep this\n  prompt.");
    expect(readField(out, "provider")).toBe("claude");
  });

  it("removes a field", () => {
    expect(writeField(TEXT, "model", undefined)).not.toContain("model:");
  });

  it("leaves unparseable text alone", () => {
    expect(writeField("name: [unclosed", "model", "x")).toBe("name: [unclosed");
  });
});
