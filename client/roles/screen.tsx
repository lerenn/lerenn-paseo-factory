import { usePaseo, useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink, SettingsInput, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ROLE_ENV } from "../../shared/roles/role";
import { SubTabs } from "../subtabs";
import { TranscriptPeek } from "../transcript-peek";
import { LaunchFields } from "./launch-fields";
import { sourcesSummary } from "./sources-summary";
import {
  clearTokenRpc,
  createPullRequestRpc,
  deleteGitRoleRpc,
  listProposalsRpc,
  listRoleAgentsRpc,
  listRolesRpc,
  saveGitRoleRpc,
  setTokenRpc,
  type GitStatus,
  type Proposal,
  type RoleEntry,
} from "../../shared/roles/rpc";
import { DEFAULT_SYNC_MINUTES, gitSourceSchema, rolesSettings, type GitSource } from "../../shared/roles/settings";

const TEMPLATE = `name: my-role
description: What this role is for.
systemPrompt: |
  You are ...
# model: claude-sonnet-5-5
# mcpServers: [linear]        # names known to the MCP proxy plugin
# maxConcurrent: 3
# env:
#   LOG_LEVEL: debug
#   API_TOKEN: \${API_TOKEN}     # secrets: reference the daemon's env, never write them here
# plugins:
#   kubeTemplate: default
#   warder: on
`;

/** A role being written: the text, and the git source it will be proposed to. */
type Editing = { text: string; original: string | null; sourceId: string };

function TemplatesTab({ theme, layout, navigation }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const listRoles = useRpc(listRolesRpc);
  const saveGitRole = useRpc(saveGitRoleRpc);
  const deleteGitRole = useRpc(deleteGitRoleRpc);
  const listProposals = useRpc(listProposalsRpc);
  const createPr = useRpc(createPullRequestRpc);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);

  const roles = useQuery({ queryKey: ["agents-roles", "roles"], queryFn: () => listRoles({}) });
  const sources = roles.data?.git ?? [];
  const entry = roles.data?.roles.find((r) => r.name === selected) ?? null;

  const proposals = useQuery({
    queryKey: ["agents-roles", "proposals"],
    queryFn: async () => (await listProposals({})).proposals,
    refetchInterval: 30_000,
  });
  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: ["agents-roles"] });
  };
  const saveGit = useMutation({
    mutationFn: (v: { sourceId: string; text: string }) => saveGitRole(v),
    onSuccess: async () => {
      setEditing(null);
      await refreshAll();
    },
  });
  const deleteGit = useMutation({
    mutationFn: (v: { sourceId: string; name: string }) => deleteGitRole(v),
    onSuccess: async () => {
      setSelected(null);
      await refreshAll();
    },
  });
  const openPr = useMutation({
    mutationFn: (id: string) => createPr({ id }),
    onSettled: refreshAll,
  });

  const newRole = () => sources[0] && setEditing({ text: TEMPLATE, original: null, sourceId: sources[0].id });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text style={styles.heading}>Templates</Text>
        {sources.length > 0 ? <Button styles={styles} label="New role" onPress={newRole} /> : null}
      </View>
      <Text style={styles.muted}>
        A role sets an agent's prompt, model, tools and environment when it starts. Roles are loaded from git sources;
        select one for an agent with {ROLE_ENV}.
      </Text>

      {roles.error ? <Text style={styles.error}>{String(roles.error)}</Text> : null}

      {roles.data && sources.length === 0 ? (
        <View style={styles.panel}>
          <Text style={styles.heading}>No roles yet</Text>
          <Text style={styles.muted}>Add a git source in the Factory Settings tab to load roles.</Text>
        </View>
      ) : null}
      {roles.data && sources.length > 0 && roles.data.roles.length === 0 ? (
        <View style={styles.panel}>
          <Text style={styles.heading}>No roles in your git sources yet</Text>
          <Text style={styles.muted}>Sync them, or create the first role.</Text>
          <Button styles={styles} primary label="New role" onPress={newRole} />
        </View>
      ) : null}

      {roles.data?.roles.map((r) => (
        <Pressable
          key={r.name}
          accessibilityRole="button"
          accessibilityLabel={`Role ${r.name}`}
          onPress={() => {
            setSelected(selected === r.name ? null : r.name);
            setEditing(null);
          }}
          style={[styles.card, selected === r.name && styles.cardActive]}
        >
          <View style={styles.row}>
            <Text style={styles.name}>{selected === r.name ? "▾" : "▸"} {r.name}</Text>
            <Text style={[r.error ? styles.error : styles.muted, { flex: 1 }]} numberOfLines={1}>
              {r.error ?? r.role?.description ?? ""}
            </Text>
            {r.role?.model ? <Text style={styles.muted} numberOfLines={1}>{r.role.model}</Text> : null}
            <Text style={styles.badge} numberOfLines={1}>{r.origin}</Text>
          </View>
        </Pressable>
      ))}

      {editing ? (
        <View style={styles.panel}>
          <Text style={styles.heading}>{editing.original ? `Edit ${editing.original}` : "New role"}</Text>
          {sources.length > 1 ? (
            <SettingsSelect
              label="Git source"
              value={editing.sourceId}
              options={sources.map((s) => ({ label: `${s.label} (${s.writeMode})`, value: s.id }))}
              onValueChange={(sourceId) => setEditing({ ...editing, sourceId })}
            />
          ) : null}
          <LaunchFields text={editing.text} onChange={(text) => setEditing({ ...editing, text })} />
          <TextInput
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            value={editing.text}
            onChangeText={(text) => setEditing({ ...editing, text })}
            style={styles.editor}
            accessibilityLabel="Role definition"
          />
          <Text style={styles.muted}>
            Saving commits this to the git source: as a pull request branch by default, or straight to the branch in
            push mode.
          </Text>
          {saveGit.error ? <Text style={styles.error}>{(saveGit.error as Error).message}</Text> : null}
          <View style={styles.row}>
            <Button
              styles={styles}
              label={saveGit.isPending ? "Saving…" : "Save to git"}
              primary
              onPress={() => saveGit.mutate({ sourceId: editing.sourceId, text: editing.text })}
            />
            <Button styles={styles} label="Cancel" onPress={() => setEditing(null)} />
          </View>
        </View>
      ) : entry ? (
        <Detail
          entry={entry}
          styles={styles}
          onEdit={() => setEditing({ text: entry.text, original: entry.name, sourceId: entry.sourceId })}
          onDelete={() => deleteGit.mutate({ sourceId: entry.sourceId, name: entry.name })}
          busy={deleteGit.isPending}
          error={deleteGit.error ? (deleteGit.error as Error).message : null}
          navigation={navigation}
          gitStatus={sources.find((g) => g.id === entry.sourceId)}
        />
      ) : null}

      <ProposalsPanel
        styles={styles}
        proposals={proposals.data ?? []}
        busyId={openPr.isPending ? openPr.variables : undefined}
        error={openPr.error ? (openPr.error as Error).message : null}
        onCreatePr={(id) => openPr.mutate(id)}
        hasToken={(sourceId) => sources.find((g) => g.id === sourceId)?.hasToken ?? false}
        labelFor={(sourceId, fallback) => sources.find((g) => g.id === sourceId)?.label ?? fallback}
      />
    </ScrollView>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function Detail(props: {
  entry: RoleEntry;
  styles: Styles;
  onEdit(): void;
  onDelete(): void;
  busy: boolean;
  error: string | null;
  navigation: PluginScreenProps["navigation"];
  gitStatus?: GitStatus;
}) {
  const { entry, styles } = props;
  const role = entry.role;
  const tools = [
    ...(role?.mcpServers ?? []).map((name) => `${name} (MCP server)`),
    ...(role?.preapprovedTools ?? []).map((t) => `${t.server}.${t.tool} (pre-approved)`),
  ];
  return (
    <View style={styles.panel}>
      <View style={styles.row}>
        <Text style={styles.heading}>{entry.name}</Text>
        <Text style={styles.badge}>{entry.origin}</Text>
      </View>
      <Text style={styles.muted}>{entry.file}</Text>
      <Text style={props.gitStatus?.error ? styles.error : styles.muted}>
        {gitStatusText(props.gitStatus)} Edits are proposed to the repository ({props.gitStatus?.writeMode ?? "pull-request"} mode).
      </Text>
      {entry.overrides.length > 0 ? (
        <Text style={styles.muted}>Hides the role of the same name in {entry.overrides.join(" and ")}.</Text>
      ) : null}
      {entry.error ? <Text style={styles.error}>{entry.error}</Text> : null}
      {role ? (
        <>
          <Field styles={styles} label="Provider / model" value={[role.provider, role.model].filter(Boolean).join(" / ") || "unchanged"} />
          <Field styles={styles} label="Thinking level / permission mode" value={[role.thinkingOptionId, role.modeId].filter(Boolean).join(" / ") || "unchanged"} />
          <Field styles={styles} label="Tools" value={tools.join("\n") || "none added"} />
          <Field styles={styles} label="Environment" value={Object.keys({ ...role.env, ...pluginDefaults(role) }).join(", ") || "none"} />
          <Field styles={styles} label="Max concurrent agents" value={role.maxConcurrent ? String(role.maxConcurrent) : "no limit"} />
          <Field styles={styles} label="Provider options" value={role.providerOptions ? JSON.stringify(role.providerOptions) : "none"} />
          <Field styles={styles} label="Leases" value={leaseRules(role) || "none"} />
          <Field styles={styles} label="Prompt" value={role.systemPrompt ?? "none"} />
        </>
      ) : null}
      <View style={styles.row}>
        <Button styles={styles} label="Edit" onPress={props.onEdit} />
        <Button styles={styles} label={props.busy ? "Deleting…" : "Delete"} onPress={props.onDelete} />
      </View>
      {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
      <Field styles={styles} label={`Source ${entry.origin}`} value={entry.text} />
      {role ? <StartAgent entry={entry} styles={styles} navigation={props.navigation} /> : null}
    </View>
  );
}

/** The lease rules a role carries: whether the Leases tools are on, and the prompt lines that mention a lease. */
function leaseRules(role: NonNullable<RoleEntry["role"]>): string {
  const on = role.env?.PASEO_LEASES === "on" || role.env?.PASEO_LEASES === "\"on\"";
  const lines = (role.systemPrompt ?? "").split("\n").filter((l) => /lease/i.test(l)).map((l) => l.trim());
  return [on ? "Leases tools on (PASEO_LEASES=on)" : "", ...lines].filter(Boolean).join("\n");
}

/** "claude · claude-haiku-5-5 · thinking low · plan", or "" when the role forces none of them. */
function launchSummary(role: NonNullable<RoleEntry["role"]>): string {
  return [
    role.provider,
    role.model,
    role.thinkingOptionId ? `thinking ${role.thinkingOptionId}` : undefined,
    role.modeId,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The plugin defaults a role sets, by the environment variable they become. */
function pluginDefaults(role: NonNullable<RoleEntry["role"]>): Record<string, string> {
  const p = role.plugins;
  const warder = typeof p?.warder === "string" ? { mode: p.warder, interval: undefined } : p?.warder;
  return {
    ...(p?.kubeTemplate ? { PASEO_KUBE_TEMPLATE: p.kubeTemplate } : {}),
    ...(warder?.mode ? { PASEO_WARDER: warder.mode } : {}),
    ...(warder?.interval ? { PASEO_WARDER_INTERVAL: warder.interval } : {}),
    ...(p?.ticket ? { PASEO_AGENT_TICKET: p.ticket } : {}),
  };
}

function gitStatusText(status?: GitStatus): string {
  if (!status) return "";
  const synced = status.lastSync ? `Last synced ${new Date(status.lastSync).toLocaleString()}.` : "Not synced yet.";
  const failure = status.error ? ` Last sync failed, using the previous copy: ${status.error}.` : "";
  return `${status.syncing ? "Syncing… " : ""}${synced}${failure}`;
}

type Draft = { id: number; url: string; ref: string; path: string; interval: string; writeMode: GitSource["writeMode"] };

export function GitSourcesPanel(props: {
  styles: Styles;
  open: boolean;
  onToggle(): void;
  /** In the Factory Settings tab: no collapse toggle. */
  alwaysOpen?: boolean;
  statuses: GitStatus[];
  syncing: boolean;
  onSync(): void;
  onSaved(): void;
}) {
  const { styles } = props;
  const settings = useSettings(rolesSettings);
  const nextId = useRef(0);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toDrafts = (sources: GitSource[]): Draft[] =>
    sources.map((s) => ({
      id: nextId.current++,
      url: s.url,
      ref: s.ref ?? "",
      path: s.path ?? "",
      interval: String(s.intervalMinutes),
      writeMode: s.writeMode,
    }));
  useEffect(() => {
    if (drafts === null && settings.status === "ready") setDrafts(toDrafts(settings.values.sources));
  }, [drafts, settings]);

  const edit = (id: number, patch: Partial<Draft>) =>
    setDrafts((list) => (list ?? []).map((d) => (d.id === id ? { ...d, ...patch } : d)));

  async function save() {
    if (settings.status !== "ready" || !drafts) return;
    const parsed: GitSource[] = [];
    for (const d of drafts) {
      const result = gitSourceSchema.safeParse({
        url: d.url,
        ref: d.ref.trim() || undefined,
        path: d.path.trim() || undefined,
        intervalMinutes: d.interval.trim() ? Number(d.interval) : DEFAULT_SYNC_MINUTES,
        writeMode: d.writeMode,
      });
      if (!result.success) {
        setError(`${d.url || "New source"}: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        return;
      }
      parsed.push(result.data);
    }
    setError(null);
    if (await settings.save({ ...settings.values, sources: parsed }, settings.revision)) {
      setDrafts(null);
      props.onSaved();
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.open }}
          accessibilityLabel={props.open ? "Collapse git sources" : "Expand git sources"}
          onPress={props.onToggle}
          style={styles.row}
        >
          <Text style={styles.heading}>{props.alwaysOpen ? "Git sources" : `${props.open ? "▾" : "▸"} Git sources`}</Text>
        </Pressable>
        <Button styles={styles} label={props.syncing ? "Syncing…" : "Sync now"} onPress={props.onSync} />
      </View>
      {props.open ? (
        <View style={{ gap: 10 }}>
      <Text style={styles.muted}>
        One sync feeds every module: the folder holds roles/ and blueprints/ (and leases/, warden/, inbox/). A role or blueprint in an earlier source wins. Repositories are cloned
        and pushed with the daemon's own git credentials (for example its SSH key). Edits you save here become a
        pull request or a push, depending on each source's mode.
      </Text>
      {settings.status === "invalid" || settings.status === "error" ? (
        <Text style={styles.error}>{settings.error}</Text>
      ) : null}
      {(drafts ?? []).map((d) => {
        const status = props.statuses.find((g) => g.url === d.url && (g.ref ?? "") === d.ref.trim());
        return (
          <View key={d.id} style={styles.startBox}>
            <SettingsInput label="Repository URL" initialValue={d.url} onChangeText={(url) => edit(d.id, { url })} placeholder="git@github.com:owner/repo.git" />
            <SettingsInput label="Branch or tag (optional)" initialValue={d.ref} onChangeText={(ref) => edit(d.id, { ref })} placeholder="default branch" />
            <SettingsInput label="Factory folder (optional)" initialValue={d.path} onChangeText={(path) => edit(d.id, { path })} placeholder="services/paseo/plugins/factory" />
            <SettingsInput
              label="Sync interval (minutes)"
              initialValue={d.interval}
              onChangeText={(interval) => edit(d.id, { interval })}
              placeholder={String(DEFAULT_SYNC_MINUTES)}
            />
            <SettingsSelect
              label="When you save a role change"
              hint="Pull request pushes a branch for review. Push commits straight to the branch and falls back to a pull request if the push is rejected."
              value={d.writeMode}
              options={[
                { label: "Propose a pull request", value: "pull-request" },
                { label: "Push to the branch", value: "push" },
              ]}
              onValueChange={(writeMode) => edit(d.id, { writeMode })}
            />
            {status ? <TokenControls status={status} styles={styles} onChanged={props.onSaved} /> : (
              <Text style={styles.muted}>Save sources to set a forge token.</Text>
            )}
            {status ? <Text style={status.error ? styles.error : styles.muted}>{gitStatusText(status)}</Text> : null}
            <Button styles={styles} label="Remove source" onPress={() => setDrafts((list) => (list ?? []).filter((x) => x.id !== d.id))} />
          </View>
        );
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {settings.status === "ready" && settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
      <View style={styles.row}>
        <Button
          styles={styles}
          label="Add source"
          onPress={() =>
            setDrafts((list) => [...(list ?? []), { id: nextId.current++, url: "", ref: "", path: "", interval: String(DEFAULT_SYNC_MINUTES), writeMode: "pull-request" }])
          }
        />
        <Button styles={styles} primary label={settings.status === "ready" && settings.saving ? "Saving…" : "Save sources"} onPress={save} />
      </View>
        </View>
      ) : (
        <Text style={props.statuses.some((g) => g.error) ? styles.error : styles.muted}>{sourcesSummary(props.statuses)}</Text>
      )}
    </View>
  );
}

function ProposalsPanel(props: {
  styles: Styles;
  proposals: Proposal[];
  busyId?: string;
  error: string | null;
  onCreatePr(id: string): void;
  hasToken(sourceId: string): boolean;
  labelFor(sourceId: string, fallback: string): string;
}) {
  const { styles } = props;
  const [open, setOpen] = useState(false);
  if (props.proposals.length === 0) return null;
  return (
    <View style={styles.panel}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel="Changes sent to git" onPress={() => setOpen((v) => !v)}>
        <Text style={styles.heading}>{open ? "▾" : "▸"} Changes sent to git ({props.proposals.length})</Text>
      </Pressable>
      {open && props.error ? <Text style={styles.error}>{props.error}</Text> : null}
      {open && props.proposals.slice(0, 8).map((p) => (
        <View key={p.id} style={styles.field}>
          <Text style={styles.name}>{p.title}</Text>
          <Text style={styles.muted}>
            {props.labelFor(p.sourceId, p.sourceLabel)} · {new Date(p.createdAt).toLocaleString()} · commit {p.commit.slice(0, 8)}
            {p.branch ? ` on ${p.branch}` : ` pushed to ${p.base}`}
          </Text>
          {p.fellBack ? <Text style={styles.muted}>Push was rejected ({p.fellBack}); proposed as a branch instead.</Text> : null}
          {p.pr ? (
            <ExternalLink href={p.pr.url}>{`PR #${p.pr.number} (${p.pr.state}) - open`}</ExternalLink>
          ) : p.outcome === "branch" ? (
            <View style={styles.row}>
              {props.hasToken(p.sourceId) ? (
                <Button
                  styles={styles}
                  primary
                  label={props.busyId === p.id ? "Creating…" : "Create PR"}
                  onPress={() => props.onCreatePr(p.id)}
                />
              ) : null}
              {p.compareUrl ? (
                <ExternalLink href={p.compareUrl}>
                  {props.hasToken(p.sourceId) ? "Review on the forge" : "Open prefilled PR page (no forge token set)"}
                </ExternalLink>
              ) : null}
            </View>
          ) : null}
          {p.prError ? <Text style={styles.error}>{p.prError}</Text> : null}
        </View>
      ))}
    </View>
  );
}

/** Write-only forge token: the field is never filled from storage, only "set" or "not set" is shown. */
function TokenControls({ status, styles, onChanged }: { status: GitStatus; styles: Styles; onChanged(): void }) {
  const setToken = useRpc(setTokenRpc);
  const clearToken = useRpc(clearTokenRpc);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      setValue("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!status.forge) {
    return <Text style={styles.muted}>No pull request API for this host: a prefilled compare link is offered instead.</Text>;
  }
  return (
    <View style={styles.field}>
      <SettingsInput
        label={`${status.forge} token: ${status.hasToken ? "set" : "not set"}`}
        hint="Optional. A fine-grained token with pull request write access to this repository lets you create the PR in one click; without it you get a prefilled link. Stored on the daemon, never shown again."
        initialValue=""
        secureTextEntry
        onChangeText={setValue}
        placeholder={status.hasToken ? "Enter a new token to replace it" : "Paste token"}
      />
      <View style={styles.row}>
        <Button styles={styles} label="Save token" onPress={() => value && run(() => setToken({ sourceId: status.id, token: value }))} />
        {status.hasToken ? <Button styles={styles} label="Clear token" onPress={() => run(() => clearToken({ sourceId: status.id }))} /> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function Field({ styles, label, value }: { styles: Styles; label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function StartAgent(props: { entry: RoleEntry; styles: Styles; navigation: PluginScreenProps["navigation"] }) {
  const { entry, styles } = props;
  const paseo = usePaseo();
  const [workspaceId, setWorkspaceId] = useState("");
  const [provider, setProvider] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const workspaces = useQuery({
    queryKey: ["agents-roles", "workspaces"],
    queryFn: async () => (await paseo.workspaces.list()).entries,
  });
  const providers = useQuery({
    queryKey: ["agents-roles", "providers"],
    queryFn: async () => (await paseo.providers.listAvailable()).providers.filter((p) => p.available).map((p) => p.provider),
  });
  const workspace = workspaces.data?.find((w) => w.id === workspaceId) ?? workspaces.data?.[0];
  const chosen = provider || entry.role?.provider || providers.data?.[0] || "";
  const start = useMutation({
    mutationFn: async () => {
      const agent = await paseo.workspaces.ref(workspace!.id).agents.create({
        config: { provider: chosen },
        prompt: prompt.trim() || undefined,
        env: { [ROLE_ENV]: entry.name },
        labels: { role: entry.name },
      });
      return agent.id;
    },
    onSuccess: (agentId) => props.navigation?.openAgent({ agentId }),
  });
  return (
    <View style={styles.startBox}>
      <Text style={styles.heading}>New agent with this role</Text>
      <SettingsSelect
        label="Workspace"
        value={workspace?.id ?? ""}
        options={(workspaces.data ?? []).map((w) => ({ label: `${w.projectDisplayName} / ${w.name}`, value: w.id }))}
        onValueChange={setWorkspaceId}
      />
      <SettingsSelect
        label="Provider"
        hint={entry.role?.provider ? "The role sets the provider, model, thinking level and mode it lists." : undefined}
        value={chosen}
        options={(providers.data ?? []).map((p) => ({ label: p, value: p }))}
        onValueChange={setProvider}
        disabled={Boolean(entry.role?.provider)}
      />
      <SettingsInput label="First prompt (optional)" initialValue="" onChangeText={setPrompt} />
      {start.error ? <Text style={styles.error}>{(start.error as Error).message}</Text> : null}
      <Button
        styles={styles}
        primary
        label={start.isPending ? "Starting…" : "Start agent"}
        onPress={() => chosen && workspace && start.mutate()}
      />
    </View>
  );
}

function Button({ styles, label, onPress, primary }: { styles: Styles; label: string; onPress(): void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.button, primary && styles.buttonPrimary]}
    >
      <Text style={primary ? styles.buttonPrimaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function makeStyles(theme: PluginScreenProps["theme"], compact: boolean) {
  const pad = compact ? 16 : 24;
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: pad, gap: 12 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24 },
    heading: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
    name: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    error: { color: theme.colors.foregroundMuted, fontSize: 13, fontStyle: "italic" as const },
    badge: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    card: {
      gap: 4,
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    cardActive: { borderColor: theme.colors.accent },
    panel: {
      gap: 10,
      padding: 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    field: { gap: 2 },
    label: { color: theme.colors.foregroundMuted, fontSize: 12 },
    value: { color: theme.colors.foreground, fontSize: 14 },
    editor: {
      minHeight: 260,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: 13,
      textAlignVertical: "top" as const,
    },
    startBox: { gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border },
    button: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      alignSelf: "flex-start" as const,
    },
    buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    buttonText: { color: theme.colors.foreground, fontSize: 14 },
    buttonPrimaryText: { color: theme.colors.accentForeground, fontSize: 14 },
  };
}


function AgentsTab({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const listAgents = useRpc(listRoleAgentsRpc);
  const agents = useQuery({ queryKey: ["agents-roles", "agents"], queryFn: () => listAgents({}), refetchInterval: 5_000 });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Agents running with a role</Text>
      {agents.error ? <Text style={styles.error}>{String(agents.error)}</Text> : null}
      {agents.data && agents.data.agents.length === 0 ? <Text style={styles.muted}>No live agent has a role right now.</Text> : null}
      {agents.data?.agents.map((a) => (
        <View key={a.id} style={styles.card}>
          <Pressable accessibilityRole="button" onPress={() => setOpen((o) => ({ ...o, [a.id]: !o[a.id] }))} style={styles.row}>
            <Text style={styles.name}>{open[a.id] ? "▾" : "▸"} {a.role}</Text>
            <Text style={[styles.muted, { flex: 1 }]} numberOfLines={1}>{a.title ?? a.id}</Text>
            {a.blueprint ? <Text style={styles.badge} numberOfLines={1}>{a.blueprint} · {a.stage}</Text> : null}
            <Text style={styles.badge}>{a.status}</Text>
          </Pressable>
          {open[a.id] ? (
            <View style={{ gap: 4 }}>
              <Field styles={styles} label="Workspace" value={[a.projectName, a.workspaceName].filter(Boolean).join(" / ") || a.workspaceId || "unknown"} />
              <Field styles={styles} label="Blueprint run" value={a.run ? `${a.run} (${a.blueprint} · ${a.stage})` : "none"} />
              <Field styles={styles} label="Agent" value={a.id} />
              <TranscriptPeek agentId={a.id} theme={theme} navigation={navigation} />
              {navigation?.openAgent ? <Button styles={styles} label="Open agent" onPress={() => navigation.openAgent({ agentId: a.id })} /> : null}
            </View>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

function SettingsTab({ theme, layout }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const settings = useSettings(rolesSettings);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Roles settings</Text>
      <Text style={styles.muted}>Git sources, Sync now and tokens are in the Factory Settings tab: one sync feeds roles and blueprints.</Text>
      {settings.status === "ready" ? (
        settings.values.sources.length === 0 ? (
          <Text style={styles.muted}>No git source yet.</Text>
        ) : (
          settings.values.sources.map((src, i) => (
            <View key={`${src.url}-${i}`} style={styles.card}>
              <SettingsSelect
                label={`When you save a role change (${src.url}${src.ref ? `@${src.ref}` : ""})`}
                hint="Pull request pushes a branch for review. Push commits straight to the branch and falls back to a pull request if the push is rejected."
                value={src.writeMode}
                options={[
                  { label: "Propose a pull request", value: "pull-request" },
                  { label: "Push to the branch", value: "push" },
                ]}
                onValueChange={(writeMode) =>
                  void settings.save({ ...settings.values, sources: settings.values.sources.map((x, j) => (j === i ? { ...x, writeMode } : x)) }, settings.revision)
                }
              />
            </View>
          ))
        )
      ) : (
        <Text style={styles.muted}>{settings.status === "loading" ? "Loading…" : `Settings: ${"error" in settings ? settings.error : ""}`}</Text>
      )}
      {settings.status === "ready" && settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
    </ScrollView>
  );
}

export function RolesScreen(props: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(props.theme, props.layout.compact), [props.theme, props.layout.compact]);
  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.row, { paddingHorizontal: 16, paddingTop: 12 }]}>
        <Text style={styles.title}>Agent Roles</Text>
      </View>
      <SubTabs
        theme={props.theme}
        tabs={[
          { key: "agents", label: "Agents", render: () => <AgentsTab {...props} /> },
          { key: "templates", label: "Templates", render: () => <TemplatesTab {...props} /> },
          { key: "settings", label: "Settings", render: () => <SettingsTab {...props} /> },
        ]}
      />
    </View>
  );
}
