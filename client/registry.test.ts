import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = Symbol.for("paseo.factory.client");
const STORE_KEY = Symbol.for("paseo.factory.client.tabs");
const g = globalThis as Record<symbol, any>;
const Tab = (() => null) as never;

/** A fresh copy of the module, as a reloaded Factory bundle would get. */
async function freshRegistry() {
  vi.resetModules();
  return import("./registry");
}

describe("extension tab registry", () => {
  beforeEach(() => {
    delete g[KEY];
    delete g[STORE_KEY];
  });
  afterEach(() => {
    delete g[KEY];
    delete g[STORE_KEY];
  });

  it("renders the tab of an extension that registered before the Factory installed the registry", async () => {
    g[KEY] = [["early", Tab]];
    const r = await freshRegistry();
    r.installRegistry();
    expect(r.extensionTabView("early")).toEqual({ kind: "tab", Component: Tab });
  });

  it("renders the tab of an extension that registered after, notifies, and unregisters", async () => {
    const r = await freshRegistry();
    r.installRegistry();
    const seen = vi.fn();
    const stop = r.subscribeTabs(seen);
    const remove = g[KEY].registerTab("late", Tab);
    expect(r.extensionTabView("late")).toEqual({ kind: "tab", Component: Tab });
    expect(seen).toHaveBeenCalled();
    remove();
    expect(r.tabFor("late")).toBeUndefined();
    stop();
  });

  it("keeps a tab registered before a Factory reload (installRegistry run again from a fresh module)", async () => {
    const first = await freshRegistry();
    first.installRegistry();
    const remove = g[KEY].registerTab("shipit", Tab);

    const second = await freshRegistry();
    expect(second).not.toBe(first);
    second.installRegistry();
    expect(second.extensionTabView("shipit")).toEqual({ kind: "tab", Component: Tab });

    // The unregister handed out before the reload still works, and notifies the new module's listeners.
    const seen = vi.fn();
    const stop = second.subscribeTabs(seen);
    remove();
    expect(seen).toHaveBeenCalled();
    expect(second.extensionTabView("shipit")).toEqual({ kind: "info" });
    stop();
  });

  it("drains a queue an extension left after a reload replaced the registry with an array", async () => {
    const first = await freshRegistry();
    first.installRegistry();
    g[KEY].registerTab("kept", Tab);
    g[KEY] = [["queued", Tab]];
    const second = await freshRegistry();
    second.installRegistry();
    expect(second.tabFor("kept")).toBe(Tab);
    expect(second.tabFor("queued")).toBe(Tab);
  });

  it("shows the info card only when no tab is registered for the extension", async () => {
    const r = await freshRegistry();
    r.installRegistry();
    expect(r.extensionTabView("shipit")).toEqual({ kind: "info" });
    g[KEY].registerTab("other", Tab);
    expect(r.extensionTabView("shipit")).toEqual({ kind: "info" });
    g[KEY].registerTab("shipit", Tab);
    expect(r.extensionTabView("shipit").kind).toBe("tab");
  });
});
