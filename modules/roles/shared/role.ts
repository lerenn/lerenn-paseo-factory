import { z } from "zod";

export const ROLE_ENV = "PASEO_AGENT_ROLE";

/** The plugin id, as in paseo-plugin.json: the key of this plugin's `pluginOptions`. */
export const PLUGIN_ID = "agents-roles";
/** The id of the Role picker on the create composers (`client.addCreateOption`). */
export const ROLE_OPTION_ID = "role";
/** The picker value for "start without a role". Not a valid role name, so it cannot collide. */
export const NO_ROLE_VALUE = "~none";

/** Environment-variable names whose values are secrets: roles may only reference them. */
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY)/i;
/** Shapes of well-known secrets, refused wherever they appear in an env value. */
const SECRET_VALUE =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;
const REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * An env value is a literal (non-secret) or contains `${NAME}` references, resolved from the
 * daemon's environment when the agent starts. Secrets never belong in a role file.
 */
export const roleEnvSchema = z.record(z.string(), z.string()).superRefine((env, ctx) => {
  for (const [key, value] of Object.entries(env)) {
    const secretLike = SECRET_VALUE.test(value) || (SECRET_KEY.test(key) && !REFERENCE.test(value) && value !== "");
    if (secretLike) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} looks like a secret; reference it as \${NAME} from the daemon's environment instead of writing it here`,
      });
    }
  }
});

/** The names of MCP servers (as the MCP proxy registry knows them), or "*" for all of them. */
const mcpServerName = z.string().regex(/^(\*|[A-Za-z0-9][A-Za-z0-9_.-]*)$/, "an MCP server name, or *");

export const roleNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "role names are lowercase letters, digits, '-' and '_'");

/** A role definition file (roles/<name>.yaml, .yml or .json). */
export const roleSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Schema version of the role file. */
  version: z.literal(1).default(1),
  name: roleNameSchema,
  description: z.string().optional(),
  /** Replaces the agent provider, e.g. "claude". Omit to keep the requested one. */
  provider: z.string().optional(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  /** Prepended to any system prompt the agent was created with. */
  systemPrompt: z.string().optional(),
  /**
   * MCP servers the agent gets, by name (for example `[linear, sentry]`, or `["*"]` for all). Names
   * only: URLs and credentials live in the MCP proxy plugin, never in a role. Passed to it as
   * `PASEO_MCP_SERVERS`; unknown names do not fail creation.
   */
  mcpServers: z.array(mcpServerName).optional(),
  /** MCP tools the agent may call without asking. */
  preapprovedTools: z.array(z.strictObject({ server: z.string(), tool: z.string() })).optional(),
  /**
   * Environment for the agent process. Values may reference the daemon's environment as
   * `${NAME}`; secrets must be references, never literals. Values given at creation take precedence.
   */
  env: roleEnvSchema.optional(),
  /**
   * At most this many agents of the role at once (initializing or running; idle and archived agents
   * do not count). Creating one more fails with a message saying so.
   */
  maxConcurrent: z.number().int().min(1).optional(),
  /**
   * Defaults for other plugins, passed as the environment those plugins read. Each is optional and
   * harmless when its plugin is not installed. Values given at creation take precedence.
   */
  plugins: z
    .strictObject({
      /** Kube Agents template: `PASEO_KUBE_TEMPLATE`. */
      kubeTemplate: z.string().optional(),
      /**
       * Agents Warder. `on` or `off` sets `PASEO_WARDER`; the object form also sets the agent's
       * default check interval as `PASEO_WARDER_INTERVAL` (for example `15m`, `1h30m` or `900` seconds).
       */
      warder: z
        .union([
          z.enum(["on", "off"]),
          z.strictObject({
            mode: z.enum(["on", "off"]).optional(),
            interval: z
              .string()
              .regex(/^(\d+h)?(\d+m)?(\d+s)?$|^\d+$/, "an interval like 15m, 1h30m or 900 (seconds)")
              .refine((v) => v !== "", "an interval like 15m, 1h30m or 900 (seconds)")
              .optional(),
          }),
        ])
        .optional(),
      /** Agents Tickets Sync ticket to bind: `PASEO_AGENT_TICKET`. */
      ticket: z.string().optional(),
    })
    .optional(),
  /**
   * Provider-specific options, merged over the requested ones. Use this for limits
   * such as a turn cap, whose names depend on the provider.
   */
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

export type Role = z.output<typeof roleSchema>;
