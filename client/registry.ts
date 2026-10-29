import type { ComponentType } from "react";

/** What an extension's tab component receives. */
export interface ExtensionTabProps {
  theme: unknown;
  layout: unknown;
  extensionId: string;
  /** Call one of the extension's `rpc` entries on the server; throws with the server's message on failure. */
  call(name: string, input?: unknown): Promise<unknown>;
  /** Leave the tab for a Factory run, an Inbox item or an outside page (the links the Activity feed builds). */
  open(link: ExtensionLink): void;
}

/** Where `open` goes: a run on the Blueprints tab (expanded), an item on the Inbox tab (opened), or a URL in the browser. */
export type ExtensionLink = { tab: "blueprints"; runId: string } | { tab: "inbox"; itemId: string } | { url: string };

export type ExtensionTabComponent = ComponentType<ExtensionTabProps>;

interface Registry {
  registerTab(extensionId: string, Component: ExtensionTabComponent): () => void;
}

interface Store {
  tabs: Map<string, ExtensionTabComponent>;
  listeners: Set<() => void>;
}

const KEY = Symbol.for("paseo.factory.client");
/**
 * The registered tabs and their listeners live on `globalThis`, not in this module: when the Factory plugin reloads
 * (a new bundle, so a new module instance) an extension that registered once at contribute time does not register
 * again, and its tab must still be there.
 */
const STORE_KEY = Symbol.for("paseo.factory.client.tabs");

function store(): Store {
  const g = globalThis as Record<symbol, unknown>;
  const s = g[STORE_KEY] as Store | undefined;
  if (s && s.tabs instanceof Map && s.listeners instanceof Set) return s;
  const fresh: Store = { tabs: new Map(), listeners: new Set() };
  g[STORE_KEY] = fresh;
  return fresh;
}

const notify = () => store().listeners.forEach((l) => l());

function registerTab(id: string, Component: ExtensionTabComponent): () => void {
  store().tabs.set(id, Component);
  notify();
  return () => {
    const { tabs } = store();
    if (tabs.get(id) === Component) tabs.delete(id);
    notify();
  };
}

/**
 * Extensions' client bundles load in any order. Until the Factory installs the registry they push to a
 * queue (`globalThis[Symbol.for("paseo.factory.client")]` as an array of `[id, Component]`); the Factory drains it.
 * Once installed, that global is an object with `registerTab`. Installing again (a Factory reload) keeps the tabs
 * already registered, since they live in a global store.
 */
export function installRegistry(): void {
  const g = globalThis as Record<symbol, unknown>;
  const queued = Array.isArray(g[KEY]) ? (g[KEY] as [string, ExtensionTabComponent][]) : [];
  store();
  const registry: Registry = { registerTab };
  g[KEY] = registry;
  for (const [id, Component] of queued) registry.registerTab(id, Component);
}

export function tabFor(id: string): ExtensionTabComponent | undefined {
  return store().tabs.get(id);
}

export function subscribeTabs(listener: () => void): () => void {
  const { listeners } = store();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the Factory shows for an extension's tab: its registered component, or the info card when none is registered. */
export function extensionTabView(id: string): { kind: "tab"; Component: ExtensionTabComponent } | { kind: "info" } {
  const Component = tabFor(id);
  return Component ? { kind: "tab", Component } : { kind: "info" };
}
