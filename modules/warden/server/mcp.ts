import { z } from "zod";
import { UsageError, type ToolContext, type ToolDef } from "./tools";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

/** Shown to agents through the MCP `instructions` field of the initialize result. */
export const INSTRUCTIONS = `Warden watches your long-running work and prompts you if you go quiet.

When to use it: before you start something that takes a while or that you wait on (a build, CI, a deploy, a review, a subagent), call warden_register(task, interval_minutes). The task says what you are doing or waiting for; Warden pings you about a minute after your turn ends without warden_done, so idle stops are caught fast. interval_minutes only matters for hangs while you are still running: it is how long you may stay silent, and values above the max (default 15 min) are clamped. You can omit it. Use until (ISO 8601) if the task has a natural deadline.

Tools:
- warden_register: register a task for yourself. Returns task_id.
- warden_update(task_id, note): record progress. Counts as activity and restarts the timer.
- warden_done(task_id, result): finish the task. Always call it when the work is done or abandoned, so you stop being prompted.
- warden_list: list your active tasks.
- warden_register_subagent(agent_id, task, interval_minutes): if you manage subagents, guard one of them; you are notified if it stays unresponsive.

A message starting with "Warden:" is an inactivity ping: your turn ended without warden_done, or you went silent too long. Reply by continuing the task, or call warden_update with where you are, or warden_done if it is finished. If you ignore several pings, your parent agent is notified.

Rules: keep one task per piece of work, pick an interval longer than your longest normal silent step, and do not register tasks for work you are actively doing in short turns.`;

/** Minimal MCP server over streamable HTTP (JSON responses, no streaming, no sessions). */
export class McpServer {
  constructor(
    private readonly tools: ToolDef[],
    /** Callable but not listed: deprecated aliases. */
    private readonly aliases: ToolDef[] = [],
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
          serverInfo: { name: "warden", version: this.version },
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
        const tool = [...this.tools, ...this.aliases].find((t) => t.name === req.params?.name);
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
