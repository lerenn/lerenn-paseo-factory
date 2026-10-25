import { describe, expect, it, vi } from "vitest";
import { installRegistry, subscribeTabs, tabFor } from "./registry";

const KEY = Symbol.for("paseo.factory.client");
const Tab = (() => null) as never;

describe("extension tab registry", () => {
  it("drains tabs queued by bundles that loaded first, then takes direct registrations", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = [["early", Tab]];
    installRegistry();
    expect(tabFor("early")).toBe(Tab);
    const seen = vi.fn();
    const stop = subscribeTabs(seen);
    const remove = ((globalThis as Record<symbol, any>)[KEY]).registerTab("late", Tab);
    expect(tabFor("late")).toBe(Tab);
    expect(seen).toHaveBeenCalled();
    remove();
    expect(tabFor("late")).toBeUndefined();
    stop();
  });
});
