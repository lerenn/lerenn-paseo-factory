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
export const INSTRUCTIONS = `Agents Leases makes sure only one agent at a time works on a shared resource (a PR, a QA environment, anything with a name you agree on).

How it works: a lease is a name held by one agent for a TTL (seconds). Take it with lease_acquire before touching the resource, keep the returned token, renew before it expires and release it when done. A lease that is not renewed expires. The token is a handover counter: it changes every time the lease changes holder, and renew or release with an old token are refused, which tells you that you lost the lease.

Modes of lease_acquire:
- queue (default): if someone else holds the lease you are queued, status is "queued". END YOUR TURN: when the lease is yours you are woken with a message starting with "Agents Leases:" that carries your token. Do not poll or work on the resource meanwhile.
- takeover (newest wins): you take the lease at once and the previous holder is told it lost it. Use it when the newest request supersedes the older one.

If you receive a message saying you lost a lease (taken over, expired, released by a human, archived), stop working on that resource immediately; do not renew or release it.

Tools:
- lease_acquire(name, ttl, mode?): ttl in seconds. Returns status "held" with token and expires_at, or "queued" with your position. Calling it again for a lease you hold renews it.
- lease_renew(name, token, ttl?): extends your lease by its TTL (or ttl). Refused if the token is stale.
- lease_release(name, token): gives the lease up; the next waiter gets it. Without token, leaves the waiting queue.
- lease_list(): all leases with holder, mode, expiry and queue.

Leases are released automatically when the holder agent is archived. Which lease names and TTLs to use is up to your instructions; keep names stable, for example "pr:org/repo#123".`;

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
          serverInfo: { name: "leases", version: this.version },
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
