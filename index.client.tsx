import type { PluginClientContext } from "@getpaseo/plugin/client";

/** No screen: the plugin only serves the Factory's PR facts on the server. */
export default function contribute(_client: PluginClientContext) {
  return () => {};
}
