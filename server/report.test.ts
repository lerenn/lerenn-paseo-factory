import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReporter } from "./report";

const report = { subject: "Run bp-1 done", body: "Factory: run bp-1 done.", kind: "run" };

function endpoint(content?: object) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "mail-")), "endpoint.json");
  if (content) writeFileSync(file, JSON.stringify(content));
  return file;
}

describe("Factory reports", () => {
  it("go through Agents Mail when it answers", async () => {
    const file = endpoint({ url: "http://127.0.0.1:1/", token: "t", apiVersion: 1 });
    const fetchImpl = vi.fn(async (_u: string, _i?: unknown) => ({ ok: true }) as Response);
    const send = vi.fn(async () => undefined);
    await createReporter({ file: () => file, fetchImpl: fetchImpl as never, send })("ag1", report);
    expect(send).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["http://127.0.0.1:1/api/health", "http://127.0.0.1:1/api/mails"]);
    const post = fetchImpl.mock.calls[1][1] as { body: string; headers: Record<string, string> };
    expect(post.headers.authorization).toBe("Bearer t");
    expect(JSON.parse(post.body)).toEqual({ to: "ag1", subject: "Run bp-1 done", body: report.body, kind: "run", asAgent: { agentId: "factory", name: "Factory" } });
  });

  it("falls back to a direct message when Agents Mail is not installed, without calling anything", async () => {
    const fetchImpl = vi.fn();
    const send = vi.fn(async () => undefined);
    await createReporter({ file: () => endpoint(), fetchImpl: fetchImpl as never, send })("ag1", report);
    expect(send).toHaveBeenCalledWith("ag1", report.body);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back when the health check or the mail fails, and remembers the outage for a minute", async () => {
    const file = endpoint({ url: "http://x", token: "t" });
    let t = 0;
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const send = vi.fn(async () => undefined);
    const r = createReporter({ file: () => file, fetchImpl: down as never, send, now: () => t });
    await r("a", report);
    await r("b", report);
    expect(send).toHaveBeenCalledTimes(2);
    expect(down).toHaveBeenCalledTimes(1);
    t = 61_000;
    await r("c", report);
    expect(down).toHaveBeenCalledTimes(2);

    const rejects = vi.fn(async (u: string) => ({ ok: u.endsWith("/health") }) as Response);
    const send2 = vi.fn(async () => undefined);
    await createReporter({ file: () => file, fetchImpl: rejects as never, send: send2 })("a", report);
    expect(send2).toHaveBeenCalledWith("a", report.body);
  });
});
