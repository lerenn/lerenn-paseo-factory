import { z } from "zod";
import type { CallContext, HostTool } from "./tools";
import { UsageError } from "./tools";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

/** What the MCP server reads from the host on each request, so modules and extensions can come and go. */
export interface ToolSource {
  tools(): HostTool[];
  /** Callable but not listed: deprecated aliases. */
  aliases(): HostTool[];
  instructions(): string;
}

/** Minimal MCP server over streamable HTTP (JSON responses, no streaming, no sessions). */
export class McpServer {
  constructor(
    private readonly source: ToolSource,
    private readonly version = "0.1.0",
  ) {}

  /** Returns the JSON-RPC response, or null for a notification. */
  async handle(message: unknown, ctx: CallContext): Promise<object | null> {
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
          serverInfo: { name: "factory", version: this.version },
          instructions: this.source.instructions(),
        });
      }
      case "ping":
        return reply({});
      case "tools/list": {
        const labels = await ctx.labels();
        const visible = this.source.tools().filter((t) => !t.requiresLabel || labels[t.requiresLabel.key] === t.requiresLabel.value);
        return reply({
          tools: visible.map((t) => ({ name: t.name, description: t.description, inputSchema: t.jsonSchema ?? z.toJSONSchema(t.input, { io: "input" }) })),
        });
      }
      case "tools/call": {
        const tool = [...this.source.tools(), ...this.source.aliases()].find((t) => t.name === req.params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${req.params?.name}`);
        if (tool.requiresLabel && (await ctx.labels())[tool.requiresLabel.key] !== tool.requiresLabel.value) {
          return reply(textResult(`${tool.name} is not available to this agent.`, true));
        }
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
