import type { ComponentType } from "react";

/** What an extension's tab component receives. */
export interface ExtensionTabProps {
  theme: unknown;
  layout: unknown;
  extensionId: string;
  /** Call one of the extension's `rpc` entries on the server; throws with the server's message on failure. */
  call(name: string, input?: unknown): Promise<unknown>;
}

export type ExtensionTabComponent = ComponentType<ExtensionTabProps>;

interface Registry {
  registerTab(extensionId: string, Component: ExtensionTabComponent): () => void;
}

const KEY = Symbol.for("paseo.factory.client");
const tabs = new Map<string, ExtensionTabComponent>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/**
 * Extensions' client bundles load in any order. Until the Factory installs the registry they push to a
 * queue (`globalThis[Symbol.for("paseo.factory.client")]` as an array of `[id, Component]`); the Factory drains it.
 */
export function installRegistry(): void {
  const g = globalThis as Record<symbol, unknown>;
  const queued = Array.isArray(g[KEY]) ? (g[KEY] as [string, ExtensionTabComponent][]) : [];
  const registry: Registry = {
    registerTab(id, Component) {
      tabs.set(id, Component);
      notify();
      return () => {
        if (tabs.get(id) === Component) tabs.delete(id);
        notify();
      };
    },
  };
  g[KEY] = registry;
  for (const [id, Component] of queued) registry.registerTab(id, Component);
}

export function tabFor(id: string): ExtensionTabComponent | undefined {
  return tabs.get(id);
}

export function subscribeTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
