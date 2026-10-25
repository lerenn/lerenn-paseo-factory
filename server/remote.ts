import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ExtensionRegistration, StageOutcome } from "./extensions";

/** Registration of an extension that runs in another plugin's process, reached over its loopback server. */
export const remoteRegistrationSchema = z.object({
  id: z.string(),
  version: z.string(),
  tab: z.string().optional(),
  callback: z.object({ url: z.string(), token: z.string().min(8) }),
  tools: z.array(z.object({ name: z.string(), description: z.string().default(""), inputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }) })).default([]),
  rpc: z.array(z.object({ name: z.string() })).default([]),
  stageKinds: z.array(z.object({ kind: z.string() })).default([]),
  roles: z.array(z.object({ name: z.string(), yaml: z.string() })).default([]),
});
export type RemoteRegistration = z.output<typeof remoteRegistrationSchema>;

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const CALL_TIMEOUT_MS = 60_000;
export const MAX_FAILURES = 3;

/** Pending stage outcomes of long-running remote stage kinds, completed by `POST /stages/<token>/outcome`. */
export class PendingOutcomes {
  private readonly waiting = new Map<string, { resolve(o: StageOutcome): void; timer: ReturnType<typeof setTimeout> }>();

  wait(token: string, timeoutMs: number): Promise<StageOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(token);
        resolve({ verdict: "error", summary: "the extension never reported the stage outcome" });
      }, timeoutMs);
      this.waiting.set(token, { resolve, timer });
    });
  }

  complete(token: string, outcome: StageOutcome): boolean {
    const w = this.waiting.get(token);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiting.delete(token);
    w.resolve(outcome);
    return true;
  }
}

export interface RemoteHandle {
  registration: ExtensionRegistration;
  /** Consecutive network failures; the Factory drops the extension at MAX_FAILURES. */
  failures: number;
  callback: { url: string; token: string };
  remote: true;
}

async function post(h: { callback: { url: string; token: string }; failures: number }, path: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(new URL(path, h.callback.url).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.callback.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS) as never,
    });
  } catch (error) {
    h.failures += 1;
    throw new Error(`extension unreachable: ${(error as Error).message}`);
  }
  h.failures = 0;
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(json?.error ?? `extension answered ${res.status}`);
  return json;
}

/**
 * Turn a remote registration into a normal one whose tools, rpc and stage kinds forward to the extension:
 *   POST <callback>/tools/<name>   {input, callerId}              -> {result}
 *   POST <callback>/rpc/<name>     {input, callerId}              -> {output}
 *   POST <callback>/stages/<kind>  {runId, stageId, blueprint, params, vars, outcomeToken} -> {outcome} | {pending: true}
 * A pending stage is completed later by the extension with POST <factory>/stages/<outcomeToken>/outcome.
 */
export function buildRemote(raw: RemoteRegistration, pending: PendingOutcomes): RemoteHandle {
  const callback = { url: raw.callback.url, token: raw.callback.token };
  if (!LOOPBACK.test(callback.url)) throw new Error("callback.url must be a loopback http URL");
  const handle: RemoteHandle = {
    remote: true,
    failures: 0,
    callback,
    registration: {
      id: raw.id,
      version: raw.version,
      tab: raw.tab,
      roles: raw.roles,
      tools: raw.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input: z.looseObject({}) as never,
        jsonSchema: t.inputSchema,
        async run(input: unknown, call: { callerId: string }) {
          return (await post(handle, `/tools/${encodeURIComponent(t.name)}`, { input, callerId: call.callerId }))?.result;
        },
      })),
      rpc: raw.rpc.map((r) => ({
        name: r.name,
        input: z.unknown(),
        output: z.unknown(),
        async run(input: unknown, call: { callerId: string }) {
          return (await post(handle, `/rpc/${encodeURIComponent(r.name)}`, { input, callerId: call.callerId }))?.output;
        },
      })),
      stageKinds: raw.stageKinds.map((k) => ({
        kind: k.kind,
        async run(ctx) {
          const outcomeToken = randomBytes(16).toString("base64url");
          const answer = await post(handle, `/stages/${encodeURIComponent(k.kind)}`, {
            runId: ctx.runId,
            stageId: ctx.stageId,
            blueprint: ctx.blueprint,
            params: ctx.params,
            vars: ctx.vars,
            outcomeToken,
          });
          if (answer?.pending) return pending.wait(outcomeToken, 7 * 24 * 3600 * 1000);
          return answer?.outcome as StageOutcome;
        },
      })),
    },
  };
  return handle;
}

/** A liveness probe: any HTTP answer on GET <callback>/health counts as alive. */
export async function probe(h: { callback: { url: string; token: string }; failures: number }): Promise<boolean> {
  try {
    await fetch(new URL("/health", h.callback.url).toString(), { headers: { authorization: `Bearer ${h.callback.token}` }, signal: AbortSignal.timeout(5000) as never });
    h.failures = 0;
    return true;
  } catch {
    h.failures += 1;
    return false;
  }
}
