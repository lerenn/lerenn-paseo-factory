# Paseo Factory

One Paseo plugin that merges **Roles**, **Blueprints**, **Leases**, **Warden** and **Inbox**. Each module is a tab of the Factory screen and can be switched off in the Factory settings. One MCP server, `factory`, serves all their tools; one git source feeds roles and blueprints.

| Module | Tab | What it does | MCP tools |
|---|---|---|---|
| Roles | Roles | Agent roles from git (`PASEO_AGENT_ROLE=<name>`) | none (hook) |
| Blueprints | Blueprints | Flows: stages name roles, verdicts pick the next stage | `blueprint_list`, `_start`, `_status`, `_verdict`, `_retry`, `_abort`, `_resume` |
| Leases | Leases | One agent at a time on a named resource | `lease_acquire`, `_renew`, `_release`, `_list` |
| Warden | Warden | Pings agents that go quiet; supervises subagents | `warden_register`, `_register_subagent`, `_update`, `_done`, `_list` |
| Inbox | Inbox | Multiple-choice questions and approvals for the human (2 to 4 options, an open "Other" always added) | `inbox_ask`, `_status`, `_list`, `_withdraw`, `_pending`, `_answer` |

There is no data migration. Setting `importLegacyState` (off by default) copies the state file of the old stand-alone plugin (`agents-leases`, `agents-warden`, `agents-inbox`) once, for a module that has no Factory state yet.

## Supervisor

A sixth tab (between Overview and Activity) for the **Supervisor**: ONE persistent agent per Factory (role `supervisor`, label `paseo.factory.supervisor=1`, created without a kube template so it runs on the daemon; its id is kept in `supervisor.json`). A PM supervises one run; the Supervisor supervises the Factory: runs paused, failed or waiting for a PM that does not exist, spawn failures, lease contention and expiry, extension health, role and blueprint load errors, git sync errors, Warden escalations. The Factory sends it a debounced "Factory digest" (a problem is told once, again after `repeatMinutes` while open); it acts with `blueprint_abort/_retry/_resume`, asks the user with `inbox_ask`, and changes roles or blueprints only through lab pull requests.

- Open to every agent: `supervisor_ask(question)` relays your question (with your agent name) and returns the answer, or a request id to poll with `supervisor_ask_status`; `supervisor_status` shows its state and stable agent id (steer it directly with a normal agent message too).
- Supervisor only: `supervisor_reply(request, answer)`, `extension_restart(id)`. A restart calls `POST <callback>/restart` on the extension (extensions opt in; 404 means unsupported) and is allowed once per hour per extension.
- Settings: `autoStart`, `cwd` (or `FACTORY_DEFAULT_CWD`), `role`, `defaultProvider`, `digestSeconds`, `repeatMinutes`, `askTimeoutSeconds`. The tab embeds the Supervisor's normal agent conversation (the app's own thread and composer; requests from agents show as ordinary messages), status, watched problems and a Start / Restart button. `PASEO_SUPERVISOR=off` skips the supervisor tools for an agent.

## Warden is for Factory agents only

`warden_register`, `warden_register_subagent` and `/warden` refuse any agent without the label `paseo.factory=1` (the label the Factory puts on its workers and PM; extensions that spawn agents should add it, and set `PASEO_WARDEN=on` in their env so Warden is injected). The `warden_*` tools are hidden from other agents (`inbox_answer` likewise from agents without `paseo.assistant=1`). Warden's setting `scope` defaults to `factory`; every minute it also drops watches of archived or vanished agents and of non-Factory agents.

## Layout

Source lives in `client/`, `server/` and `shared/` only (Paseo's plugin loader requires it); each module has a subfolder in each (`server/warden`, `client/warden`, `shared/warden`). `layout.test.ts` checks this in CI.

## Git source

Roles and blueprints come from one git source (Roles tab settings): `url`, `ref`, and `path` = the **Factory folder**, whose subfolders are `roles/`, `blueprints/`, `leases/`, `warden/`, `inbox/`. Example: `services/paseo/plugins/factory`. Roles are `roles/<name>.yaml` ([format](role.schema.json), examples in `shared/examples/roles`); blueprints are `blueprints/<name>.toml` (examples in `shared/examples/blueprints`).

## Blueprints

```toml
version = 1
name = "ticket"
confirm = ["ticket"]            # must be checked for real; start passes ticket_confirmed = "true"
pm_extra_max = 2                # the PM's one judgement may grant at most this many extra attempts
[vars.ticket]
required = true
pattern = "^[A-Z]+-[0-9]+$"

[[stage]]
id = "implement"
role = "implementer"            # PASEO_AGENT_ROLE of the worker
prompt = "Implement {{ticket}} ... {{stage.investigate.summary}}"
max_attempts = 3                # tries per entry; a turn that ends without a verdict uses one
max_runs = 50                   # entries over the run (loops)
flake_retries = 1               # failed turns retried for free
facts = "pr"                    # show GitHub facts; data.pr_urls is checked on GitHub
[stage.on]
done = "qa"                     # verdict -> next stage ("done" and "failed" end the run)
blocked = "ask-blocked"
exhausted = "pm"                # PM judgement, once; or a stage id, or "failed"
[stage.verify]
done = ["exists", "open"]       # facts GitHub must confirm before the verdict is accepted
```

Stage kinds: `agent` (default), `gate` (question or approval through the Inbox; `pr = ...` ties it to PR heads, `criteria = ...` is hashed and an identical approval is reused, `store_as` saves a typed answer into a variable, `note_to` adds it to another stage's prompt), `call` (a tool such as `releaser_join`; a Factory or extension tool is called directly, any other by a short-lived worker of the stage's `role`), `blueprint` (a child run, `at` enters it mid-way), and any kind an extension provides. `skip_if = "{{x}} == y"` needs an `on.skipped` edge. `agent = "reuse:<stage>"` sends the task to that stage's worker (a replacement with the same role if it is gone).

Runs are JSON in `~/.paseo/plugin-data/paseo-factory/blueprints.json`, written before every transition; after a daemon restart, running stages are re-dispatched, open gates re-read. Workers are created with `PASEO_AGENT_ROLE`, `PASEO_FACTORY_RUN` and the labels `paseo.factory=1`, `paseo.factory.blueprint`, `.run`, `.stage`, `.role`; every worker gets a Warden task. The Blueprints tab shows one card per run.

PM tools (`blueprint_start` ...) are injected into agents whose `PASEO_AGENT_ROLE` equals the `pmRole` setting (default `pm`) or that have `PASEO_FACTORY_BLUEPRINTS=on`; stage workers get `blueprint_verdict` and `blueprint_status`. `blueprint_retry`, `_resume` and `_abort` are for the run's PM, its starter and agents labelled `paseo.assistant=1`.

## Spend, timelines and flows

The Overview tab (first, default) is a read-only dashboard: blueprint runs (failing or stalled highlighted), pending Inbox items, leases, Warden attention, live role agents, git sync status, extension health, recent activity and **Spend**. Spend aggregates Paseo's per-turn usage (`lastUsage`: tokens and `totalCostUsd`), recorded at each `agent.turn_ended` of agents the Factory spawned (label `paseo.factory=1`), per run, role and day (RPC `blueprints.spend`, stored in `spend.json`). Each run card has a **Timeline**: time per stage, working vs waiting, dispatches and retries, gate open/close times and escalations, built from the run's saved history. Next to Timeline, **Flows** (default view stays Timeline) draws the run as a graph: stages (agents) as nodes, verdict transitions as edges, the path taken highlighted, live state and child runs; on a blueprint template it shows the static shape.

## Activity, diffs, transcripts

The **Activity** tab is a factory-wide feed (runs, stage changes, gates, escalations, leases, Inbox items, merges and deploys) with filters by type, blueprint and role. Extensions add events with `POST /extensions/event` `{ id, type: "merge"|"deploy"|..., title, detail?, link? }` (bearer = endpoint token). Run cards show each PR's diff summary (files, +/−, read with `gh pr view`) and a link to the full diff, and an expandable read-only "latest messages" peek of the stage's agent (also in Roles › Agents).

## Start endpoint (Events plugin)

The Factory writes `~/.paseo/factory/endpoint.json` (mode 0600, `{url, token}`) and serves on loopback only, with the token as a bearer:

- `POST /blueprints/start`, body `{blueprint, vars, requestedBy, idempotencyKey}` → `200 {runId}`, `404` unknown blueprint, `400` bad vars, `401`. The same `idempotencyKey` returns the same run.
- `GET /blueprints` → names, descriptions and variables (`required`).

## Inbox and the Assistant

`inbox_pending` lists every pending item and `inbox_answer(item, answer)` answers one; both are for agents labelled `paseo.assistant=1` (others see only their own items and cannot answer). The answer is recorded as "answered by the Assistant on behalf of the user".

## Reports, exclusions, roadmap

- **Reports go through Agents Mail when it is installed.** Information the Factory sends to an agent (Supervisor digests, run finished or failed notices) is mailed (`kind` digest | run) if `~/.paseo/agents-mail/endpoint.json` exists and `/api/health` answers (checked once a minute); otherwise, or if the mail fails, it is sent directly as before. Tasks, nudges, judgement calls, `supervisor_ask` and Inbox questions stay direct.
- **`excludePaths` / `excludeAgents` (Factory settings).** The Factory never lists, watches, digests or spawns an agent whose directory is inside an excluded path (default: the Security coordinator's anyshift-monorepo checkout), and refuses to spawn there.
- **Roadmap:** merge the Assistant's Decisions with the Factory Inbox (later; the Inbox stays as it is).

## Extensions

Another plugin registers with the Factory; it gets no sidebar row, only a Factory tab, and its tools join the `factory` MCP server:

```ts
const factory = (globalThis as any)[Symbol.for("paseo.factory")];
const unregister = factory.registerExtension({
  id: "release-trains", version: "1.0.0", tab: "Release Trains",
  tools: [{ name: "train_status", description: "...", input: z.object({}), run: (input, call) => ({}) }],
  stageKinds: [{ kind: "train", run: async (ctx) => ({ verdict: "ok", summary: "..." }) }],
  roles: [{ name: "train-runner", yaml: "name: train-runner\n..." }],
});
```

`ctx` carries `runId`, `stageId`, `params` (the stage's own fields, templates rendered), `vars`, `paseo`, `signal` and `services` (`spawn`, `leases`, `warden`, `inbox`; `factory.services()` gives the same outside a stage). Stage kinds must be idempotent: a running stage runs again after a restart. If the extension loads before the Factory, push the registration onto `globalThis[Symbol.for("paseo.factory.pending")]` (an array); the Factory drains it.

### Extensions in another plugin's process

Paseo runs each plugin's server in its own process, so `globalThis` registration only works for code inside the Factory's process. Other plugins register over the Factory's loopback endpoint (`~/.paseo/factory/endpoint.json`, bearer = its token) and serve a small loopback API of their own:

`POST /extensions/register` `{ id, version, tab?, callback: { url, token }, tools: [{ name, description, inputSchema }], rpc: [{ name }], stageKinds: [{ kind }], roles? }` (`callback.url` must be `http://127.0.0.1|localhost|[::1]`). Registration is idempotent: send it at start and again every minute or so; a Factory restart forgets everything and the next registration restores it. `POST /extensions/unregister` `{ id }` removes it.

The Factory forwards, with `Authorization: Bearer <callback.token>`:
- `POST <callback>/tools/<name>` `{ input, callerId }` → `{ result }` (the tool is served under the `factory` MCP server with your `inputSchema`; validate the input yourself; an error status with `{ error }` becomes the tool error).
- `POST <callback>/rpc/<name>` `{ input, callerId }` → `{ output }` (for the tab, through `factory.extension.call`).
- `POST <callback>/stages/<kind>` `{ runId, stageId, blueprint, params, vars, outcomeToken }` → `{ outcome: { verdict, summary?, data? } }`, or `{ pending: true }` for a stage that waits: finish it later with `POST <factory>/stages/<outcomeToken>/outcome` `{ verdict, summary?, data? }` (bearer = the endpoint token; one use).
- `GET <callback>/health`: any HTTP answer counts as alive. After 3 consecutive unreachable calls or probes (probed once a minute) the extension is dropped.

Roles shipped by an extension and `ctx.services` are in-process only for now.

### Extension tab UI

Add `rpc: [{ name, input: zodObject, output: zodObject, run(input, call) }]` to the registration: backend calls for your tab, validated with those schemas and reached through the Factory RPC `factory.extension.call({ id, name, input })`. In your client bundle register a component for the tab:

```ts
const queue = ((globalThis as any)[Symbol.for("paseo.factory.client")] ??= []);
const add = (id, Tab) => (Array.isArray(queue) ? queue.push([id, Tab]) : queue.registerTab(id, Tab));
add("release-trains", ({ theme, layout, extensionId, call }) => /* call("board", { ... }) */ null);
```

Until the Factory client has loaded, push `[id, Component]` onto that array; afterwards the global is the registry object and `registerTab(id, Component)` returns an unregister function. The component renders inside the extension's tab with `{ theme, layout, extensionId, call(name, input) }`; without one the tab shows the extension's metadata. It can use the host UI exports. Settings go through your own `rpc` entries (your server half reads and writes its own settings).

## Sidebar badge

On hosts with `client.addAgentBadge`, agents with the `paseo.factory` label show `<blueprint> · <stage>`; the tooltip has the run and the role. Hosts without the API are unaffected.

## Environment

`FACTORY_PORT` (default 47820), `FACTORY_DATA`, `FACTORY_ENDPOINT`, `FACTORY_BLUEPRINTS_DIR` (extra blueprint folder, first in precedence). Per-module scope variables are unchanged: `PASEO_WARDEN`, `PASEO_INBOX`, `PASEO_LEASES` = `off` to skip a module for an agent (`on` with the `opt-in` scope). `PASEO_WARDEN_INTERVAL` sets an agent's default check interval.
