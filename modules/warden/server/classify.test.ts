import { describe, expect, it } from "vitest";
import { analyze, lastAssistantText } from "./classify";

describe("analyze", () => {
  it("flags a closing message that announces future work", () => {
    const r = analyze("CI is running. I'll keep watching it and report back when it finishes.");
    expect(r.announcesFutureWork).toBe(true);
    expect(r.lastStep).toMatch(/keep watching/);
  });
  it("treats a final report as done", () => {
    const r = analyze("All done. The PR is merged and the tests pass.");
    expect(r).toMatchObject({ done: true, announcesFutureWork: false });
  });
  it("is not fooled by a mid-report promise followed by a summary", () => {
    const r = analyze("I'll check the logs.\nSummary: the bug was in the parser.\nFixed in abc123.");
    expect(r.announcesFutureWork).toBe(false);
  });
  it("ignores empty text", () => {
    expect(analyze(null).announcesFutureWork).toBe(false);
  });
});

describe("lastAssistantText", () => {
  it("joins the trailing run of assistant chunks", () => {
    expect(
      lastAssistantText([
        { type: "assistant_message", text: "old" },
        { type: "tool_call" },
        { type: "assistant_message", text: "I'll " },
        { type: "assistant_message", text: "wait." },
      ]),
    ).toBe("I'll wait.");
  });
});
