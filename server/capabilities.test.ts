import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Capabilities, EVENTS_CAPABILITY_ENV, MAIL_CAPABILITY_ENV } from "./capabilities";

function endpoint(content?: object) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "caps-")), "endpoint.json");
  if (content) writeFileSync(file, JSON.stringify(content));
  return file;
}

describe("Capabilities", () => {
  it("Agents Mail: absent without its endpoint file, with no call made", async () => {
    const fetchImpl = vi.fn();
    const caps = new Capabilities({ mailFile: () => endpoint(), fetchImpl: fetchImpl as never });
    expect(await caps.mailEndpoint()).toBeNull();
    expect(caps.mail()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Agents Mail: up when its health answers; the result is reused, a failed mail marks it down", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    const caps = new Capabilities({ mailFile: () => endpoint({ url: "http://127.0.0.1:1/", token: "t" }), fetchImpl: fetchImpl as never, now: () => t });
    expect(caps.mail()).toBe(false); // not probed yet: the first look starts in the background
    expect(await caps.mailEndpoint()).toEqual({ url: "http://127.0.0.1:1", token: "t" });
    expect(caps.mail()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    caps.markMailDown();
    expect(caps.mail()).toBe(false);
    t = 61_000;
    caps.mail();
    await caps.mailEndpoint();
    expect(caps.mail()).toBe(true);
  });

  it("per agent: what its session was given; unknown until its session opens", () => {
    const caps = new Capabilities({ mailFile: () => endpoint() });
    expect(caps.agent("a1")).toEqual({ mail: null, events: null });
    expect(caps.events()).toBeNull();
    caps.noteSession("a1", { [MAIL_CAPABILITY_ENV]: "x" });
    caps.noteSession("a2", { [MAIL_CAPABILITY_ENV]: "x", [EVENTS_CAPABILITY_ENV]: "y" });
    expect(caps.agent("a1")).toEqual({ mail: true, events: false });
    expect(caps.agent("a2")).toEqual({ mail: true, events: true });
    expect(caps.events()).toBe(true);
    caps.forget("a2");
    expect(caps.agent("a2")).toEqual({ mail: null, events: null });
  });
});
