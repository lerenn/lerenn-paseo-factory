import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startBlueprints } from "./modules/blueprints";
import { startInbox } from "./modules/inbox";
import { startLeases } from "./modules/leases";
import { startRoles } from "./modules/roles";
import { startWarden } from "./modules/warden";
import { FactoryHost } from "./server/host";
import { buildServices } from "./server/services";
import { overviewRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const host = new FactoryHost(server);

  const removers = [
    server.before("agent.create", ({ request }, ctx) => host.onCreate(request, ctx)),
    server.before("agent.session_open", ({ request }, ctx) => {
      host.capture(ctx);
      host.onSessionOpen(request.env, request.agentId);
    }),
    server.on("agent.archived", ({ agent }, ctx) => {
      host.capture(ctx);
      host.onArchived(agent.id);
    }),
  ];

  // Roles first: its create hook may set the scope variables the other modules read.
  const stops = [startRoles(host), startLeases(host), startInbox(host), startWarden(host), startBlueprints(host)];
  host.services = buildServices(host) as never;
  host.start();

  server.handle(overviewRpc, async (_input, ctx) => {
    host.capture(ctx);
    await host.ready;
    await host.listening;
    return {
      settings: host.settings,
      endpoint: { url: host.url, error: host.startError },
      extensions: host.listExtensions().map((e) => ({ id: e.id, version: e.version, tab: e.tab, tools: e.tools.map((t) => t.name), stageKinds: e.stageKinds.map((k) => k.kind) })),
    };
  });

  return async () => {
    for (const remove of removers) remove();
    for (const stop of stops) await stop();
    await host.stop();
  };
}
