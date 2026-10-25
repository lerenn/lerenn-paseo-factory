import { describe, expect, it } from "vitest";
import { messagesFromTimeline } from "./transcript";

describe("messagesFromTimeline", () => {
  it("keeps the last messages, joins streamed assistant chunks, and shows tools as one line", () => {
    const payload = {
      entries: [
        { item: { type: "user_message", text: "do it" }, timestamp: "2026-10-25T10:00:00Z" },
        { item: { type: "reasoning", text: "hmm" } },
        { item: { type: "assistant_message", text: "On " } },
        { item: { type: "assistant_message", text: "it." } },
        { item: { type: "tool_call", name: "Bash" } },
        { item: { type: "error", message: "boom" } },
      ],
    };
    expect(messagesFromTimeline(payload, 10).map((m) => [m.role, m.text])).toEqual([["user", "do it"], ["assistant", "On it."], ["tool", "Bash"], ["error", "boom"]]);
    expect(messagesFromTimeline(payload, 2).map((m) => m.role)).toEqual(["tool", "error"]);
    expect(messagesFromTimeline({ entries: [{ type: "user_message", text: "bare" }] }, 5)).toEqual([{ role: "user", text: "bare", at: null }]);
    expect(messagesFromTimeline(null, 5)).toEqual([]);
  });
});
