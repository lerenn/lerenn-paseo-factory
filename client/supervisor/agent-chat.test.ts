import { describe, expect, it } from "vitest";
import { agentChatComponent } from "./agent-chat";

describe("agentChatComponent", () => {
  it("returns the app's AgentChat when the app provides it", () => {
    const AgentChat = () => null;
    expect(agentChatComponent({ AgentChat })).toBe(AgentChat);
  });

  it("accepts a memo/forwardRef style object component", () => {
    const AgentChat = { $$typeof: Symbol.for("react.memo") };
    expect(agentChatComponent({ AgentChat })).toBe(AgentChat);
  });

  it("returns null on an app without AgentChat", () => {
    expect(agentChatComponent({})).toBeNull();
  });
});
