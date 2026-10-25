import { z } from "zod";
import { LEASE_NAME, modeSchema } from "../shared/lease";
import type { Engine } from "./engine";
import type { Lease } from "./store";

export interface ToolContext {
  engine: Engine;
  /** The calling agent. */
  callerId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodObject;
  run(input: any, ctx: ToolContext): Promise<unknown> | unknown;
}

const name = z.string().regex(LEASE_NAME, "1-200 characters among letters, digits and . : / # @ + = _ -").describe('The lease name, for example "pr:org/repo#123".');
const token = z.number().int().describe("The token returned when you got the lease.");

function held(lease: Lease, now: number, extra: object = {}) {
  const h = lease.holder!;
  return {
    name: lease.name,
    status: "held",
    token: lease.handover,
    mode: h.mode,
    ttl_seconds: h.ttlSeconds,
    expires_at: new Date(h.expiresAt).toISOString(),
    expires_in_seconds: Math.max(0, Math.round((h.expiresAt - now) / 1000)),
    ...extra,
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "lease_acquire",
    description:
      "Take the named lease before working on a shared resource. mode queue (default): if held, you are queued and woken by a message starting with \"Agents Leases:\" when it is yours; end your turn. mode takeover: you take it at once and the previous holder is told it lost it. Calling it for a lease you already hold renews it.",
    input: z.object({
      name,
      ttl: z.number().positive().describe("Seconds the lease lasts unless renewed."),
      mode: modeSchema.optional().describe('"queue" (default) or "takeover" (newest wins).'),
    }),
    run({ name, ttl, mode }, ctx) {
      const r = ctx.engine.acquire(ctx.callerId, name, ttl, mode ?? "queue");
      const now = Date.now();
      if (r.status === "held") {
        return held(r.lease, now, {
          ...(r.renewed ? { renewed: true } : {}),
          ...(r.tookOverFrom ? { took_over_from: r.tookOverFrom } : {}),
          next: "Work on the resource. Renew with lease_renew before it expires and release it with lease_release when done. If a message says you lost it, stop at once.",
        });
      }
      return {
        name,
        status: "queued",
        position: r.position,
        held_by: r.lease.holder!.agentId,
        holder_expires_at: new Date(r.lease.holder!.expiresAt).toISOString(),
        next: 'End your turn now. When the lease is yours you are woken by a message starting with "Agents Leases:" that carries your token.',
      };
    },
  },
  {
    name: "lease_renew",
    description: "Extend a lease you hold by its TTL (or ttl). Refused if your token is stale: that means you lost the lease and must stop.",
    input: z.object({ name, token, ttl: z.number().positive().optional().describe("New TTL in seconds. Default: the current one.") }),
    run: ({ name, token, ttl }, ctx) => held(ctx.engine.renew(ctx.callerId, name, token, ttl), Date.now()),
  },
  {
    name: "lease_release",
    description: "Give up a lease you hold (token required); the next waiter gets it. Without token, leave the waiting queue instead.",
    input: z.object({ name, token: token.optional() }),
    run({ name, token }, ctx) {
      const r = ctx.engine.release(ctx.callerId, name, token);
      return { name, status: r.released ? "released" : "left_queue", ...(r.promoted ? { handed_to: r.promoted } : {}) };
    },
  },
  {
    name: "lease_list",
    description: "All leases currently held or waited for: holder, mode, expiry and queue. Your own token is shown only for leases you hold.",
    input: z.object({}),
    run(_input, ctx) {
      const now = Date.now();
      return ctx.engine.views().map((v) => ({
        name: v.name,
        handover: v.handover,
        holder: v.holder
          ? {
              agent_id: v.holder.agentId,
              agent_title: v.holder.agentTitle,
              mine: v.holder.agentId === ctx.callerId,
              ...(v.holder.agentId === ctx.callerId ? { token: v.handover } : {}),
              mode: v.holder.mode,
              expires_at: new Date(v.holder.expiresAt).toISOString(),
              expires_in_seconds: Math.max(0, Math.round((v.holder.expiresAt - now) / 1000)),
            }
          : null,
        queue: v.queue.map((w, i) => ({ position: i + 1, agent_id: w.agentId, agent_title: w.agentTitle, mine: w.agentId === ctx.callerId })),
      }));
    },
  },
];

