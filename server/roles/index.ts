import type { FactoryHost } from "../host";
import { GitSources } from "./git-sync";
import { agentCreateHook, sessionOpenHook } from "./hook";
import { roleAgents } from "./agents";
import { RoleLimits } from "./limits";
import { ProposalStore } from "./proposals";
import { RolesService } from "./service";
import { TokenStore } from "./tokens";
import {
  clearTokenRpc,
  createPullRequestRpc,
  deleteGitRoleRpc,
  listProposalsRpc,
  listRoleAgentsRpc,
  listRolesRpc,
  saveGitRoleRpc,
  setTokenRpc,
  syncSourcesRpc,
} from "../../shared/roles/rpc";
import { rolesSettings, type GitSource } from "../../shared/roles/settings";

export function startRoles(host: FactoryHost) {
  const { server } = host;
  const settings = server.registerSettings(rolesSettings);
  const gitSources = new GitSources();
  const tokens = new TokenStore();

  async function configured(): Promise<GitSource[]> {
    const state = await settings.read();
    return state.status === "ready" ? state.values.sources : [];
  }
  const service = new RolesService({
    sources: gitSources,
    tokens,
    proposals: new ProposalStore(),
    configured,
  });

  void configured().then((sources) => gitSources.configure(sources));
  const unsubscribe = settings.subscribe((state) => {
    gitSources.configure(state.status === "ready" ? state.values.sources : []);
  });

  const limits = new RoleLimits();
  const createHook = agentCreateHook(async () => (await configured()).map((s) => gitSources.rolesDir(s)), limits);
  host.beforeCreate(async (request, ctx) => (host.enabled("roles") ? ((await createHook({ request }, ctx)) ?? undefined) : undefined));
  const removeSessionHook = server.before("agent.session_open", (input, ctx) => (host.enabled("roles") ? sessionOpenHook(limits)(input) : undefined));

  server.handle(listRolesRpc, async () => ({
    roles: await service.list(),
    git: service.statuses(await configured()),
  }));
  server.handle(listRoleAgentsRpc, async (_input, ctx) => {
    host.capture(ctx);
    const { entries } = await ctx.paseo.agents.list({ filter: { includeArchived: false } } as never);
    const { entries: workspaces } = await ctx.paseo.workspaces.list();
    return { agents: roleAgents((entries as unknown as { agent: never }[]).map((e) => e.agent), limits.registered(), workspaces as never) };
  });
  server.handle(syncSourcesRpc, async () => {
    const sources = await configured();
    await gitSources.syncAll(sources);
    return { git: service.statuses(sources) };
  });
  server.handle(saveGitRoleRpc, async ({ sourceId, text }) => ({
    proposal: await service.save(sourceId, text),
  }));
  server.handle(deleteGitRoleRpc, async ({ sourceId, name }) => ({
    proposal: await service.remove(sourceId, name),
  }));
  server.handle(listProposalsRpc, async () => ({ proposals: await service.proposals() }));
  server.handle(createPullRequestRpc, async ({ id }) => ({ proposal: await service.createPullRequest(id) }));
  server.handle(setTokenRpc, async ({ sourceId, token }) => {
    await service.find(sourceId);
    tokens.set(sourceId, token);
    return {};
  });
  server.handle(clearTokenRpc, ({ sourceId }) => {
    tokens.clear(sourceId);
    return {};
  });

  host.gitSources = gitSources;
  host.configuredSources = configured;

  return () => {
    removeSessionHook();
    unsubscribe();
    gitSources.stop();
  };
}
