import type { z } from "zod";

/** Who is calling a tool of the `factory` MCP server. */
export interface CallContext {
  /** The calling agent. */
  callerId: string;
  /** Labels of the calling agent, looked up on demand. */
  labels(): Promise<Record<string, string>>;
  /** Labels of any live agent (empty for an unknown or archived one). */
  labelsOf(agentId: string): Promise<Record<string, string>>;
}

/** A tool as the `factory` MCP server serves it, whichever module or extension owns it. */
export interface HostTool {
  name: string;
  /** Module id or extension id: switching the module off hides its tools. */
  owner: string;
  description: string;
  input: z.ZodObject;
  /** Advertised instead of `input`'s schema (tools served by another process validate their own input). */
  jsonSchema?: Record<string, unknown>;
  /** Only agents carrying this label see and may call the tool (like the Assistant's). */
  requiresLabel?: { key: string; value: string };
  run(input: any, ctx: CallContext): Promise<unknown> | unknown;
}

/** An error whose message is meant for the calling agent. */
export class UsageError extends Error {}

/** A module tool written against `{ engine, callerId }` as a host tool. */
export function adapt<E>(
  tool: { name: string; description: string; input: z.ZodObject; run(input: any, ctx: { engine: E; callerId: string; labels?: () => Promise<Record<string, string>>; labelsOf?: (id: string) => Promise<Record<string, string>> }): Promise<unknown> | unknown },
  engine: E,
  extra: { requiresLabel?: HostTool["requiresLabel"] } = {},
): Omit<HostTool, "owner"> {
  return { name: tool.name, description: tool.description, input: tool.input, ...extra, run: (input, call) => tool.run(input, { engine, callerId: call.callerId, labels: call.labels, labelsOf: call.labelsOf }) };
}
