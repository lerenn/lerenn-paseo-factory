import { z } from "zod";
import { type ToolContext, type ToolDef } from "./tools";
import { UsageError } from "./engine";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

/** Shown to agents through the MCP `instructions` field of the initialize result. */
export const INSTRUCTIONS = `Agents Inbox is how you ask the human a question or request an approval.

When to use it: you need a decision, an approval for a risky or irreversible step, or information only the human has. Call inbox_ask, then END YOUR TURN. Do not poll, sleep or keep working on the blocked step. The human answers in the Agents Inbox screen and you are woken with a message starting with "Agents Inbox:" that carries the answer.

Tools:
- inbox_ask(question, options?, context?, kind?, blocking?, expires_in_minutes?, default_answer?, dedupe_key?): returns item_id. kind "approval" gives the options approve and deny. Without options the human answers in free text. Asking the same question again while it is pending returns the same item, so a retry is safe. blocking (default true) means you must stop and wait; set false to carry on with other work and be told the answer later. default_answer (an option id, or text for free-text items) needs expires_in_minutes and is used if nobody answers in time; without a default an expiry wakes you with a notice.
- inbox_status(item_id): the state and answer of one of your items.
- inbox_list(status?): your items.
- inbox_withdraw(item_id, reason?): take back a pending question that no longer matters.

An answer is recorded once; you cannot answer for the human. The human's words are the answer; decide yourself whether they cover what you asked. Put what the human needs to decide in the question and context: they read it without your conversation.`;

/** Minimal MCP server over streamable HTTP (JSON responses, no streaming, no sessions). */
export class McpServer {
  constructor(
    private readonly tools: ToolDef[],
    private readonly version = "0.1.0",
  ) {}

  /** Returns the JSON-RPC response, or null for a notification. */
  async handle(message: unknown, ctx: ToolContext): Promise<object | null> {
    const req = message as RpcRequest;
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    if (req.id === undefined) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code, message } });

    switch (req.method) {
      case "initialize": {
        const asked = req.params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "inbox", version: this.version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: "input" }) })),
        });
      case "tools/call": {
        const tool = this.tools.find((t) => t.name === req.params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${req.params?.name}`);
        const parsed = tool.input.safeParse(req.params?.arguments ?? {});
        if (!parsed.success) return reply(textResult(`Invalid arguments: ${z.prettifyError(parsed.error)}`, true));
        try {
          return reply(textResult(await tool.run(parsed.data, ctx)));
        } catch (err) {
          return reply(textResult(err instanceof UsageError || err instanceof Error ? err.message : String(err), true));
        }
      }
      default:
        return fail(-32601, `Method not found: ${req.method}`);
    }
  }
}

function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
