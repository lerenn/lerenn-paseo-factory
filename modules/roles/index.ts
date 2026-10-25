import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GitSources } from "./server/git-sync";
import { agentCreateHook, sessionOpenHook } from "./server/hook";
import { RoleLimits } from "./server/limits";
import { ProposalStore } from "./server/proposals";
import { RolesService } from "./server/service";
import { TokenStore } from "./server/tokens";
import {
  clearTokenRpc,
  createPullRequestRpc,
  deleteGitRoleRpc,
  listProposalsRpc,
  listRolesRpc,
  saveGitRoleRpc,
  setTokenRpc,
  syncSourcesRpc,
} from "./shared/rpc";
import { rolesSettings, type GitSource } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
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
  const removeHook = server.before(
    "agent.create",
    agentCreateHook(async () => (await configured()).map((s) => gitSources.rolesDir(s)), limits),
  );
  const removeSessionHook = server.before("agent.session_open", sessionOpenHook(limits));

  server.handle(listRolesRpc, async () => ({
    roles: await service.list(),
    git: service.statuses(await configured()),
  }));
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

  return () => {
    removeHook();
    removeSessionHook();
    unsubscribe();
    gitSources.stop();
  };
}
