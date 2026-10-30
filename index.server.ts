import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerProvider } from "./server/provider";

/** Registers the GitHub PR facts provider for the Factory; unloading the plugin hands the reads back to the Factory's own `gh`. */
export default function contribute(_server: PluginServerContext) {
  const unregister = registerProvider();
  return () => {
    unregister();
  };
}
