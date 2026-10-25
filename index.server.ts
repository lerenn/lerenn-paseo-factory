import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startBlueprints } from "./server/blueprints";
import { startInbox } from "./server/inbox";
import { startLeases } from "./server/leases";
import { startRoles } from "./server/roles";
import { startWarden } from "./server/warden";
import { FactoryHost } from "./server/host";
import { buildServices } from "./server/services";
import { buildActivity } from "./server/activity";
import { messagesFromTimeline } from "./server/transcript";
import { activityRpc, extensionCallRpc, overviewRpc, transcriptRpc } from "./shared/rpc";

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
      extensions: host.listExtensions().map((e) => ({ id: e.id, version: e.version, tab: e.tab, tools: e.tools.map((t) => t.name), stageKinds: e.stageKinds.map((k) => k.kind), health: host.extensionHealth(e.id) })),
    };
  });

  server.handle(activityRpc, ({ limit }, ctx) => {
    host.capture(ctx);
    const bp = host.engines.blueprints?.store;
    return {
      now: Date.now(),
      items: buildActivity({
        runs: bp?.all() ?? [],
        inbox: host.enabled("inbox") ? (host.engines.inbox?.store.events() ?? []) : [],
        leases: host.enabled("leases") ? (host.engines.leases?.store.events() ?? []) : [],
        extensions: host.extensionEvents,
        limit,
      }),
    };
  });
  server.handle(transcriptRpc, async ({ agentId, limit }, ctx) => {
    host.capture(ctx);
    try {
      const payload = await host.paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: limit * 3, projection: "projected" });
      return { ok: true, messages: messagesFromTimeline(payload, limit), error: null };
    } catch (error) {
      return { ok: false, messages: [], error: (error as Error).message };
    }
  });
  server.handle(extensionCallRpc, async ({ id, name, input }, ctx) => {
    host.capture(ctx);
    try {
      return { ok: true, output: await host.callExtension(id, name, input), error: null };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  return async () => {
    for (const remove of removers) remove();
    for (const stop of stops) await stop();
    await host.stop();
  };
}
