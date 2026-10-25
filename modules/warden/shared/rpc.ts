import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { settingsSchema } from "./settings";
import { taskViewSchema } from "./task";

export const listTasksRpc = defineRpc({
  name: "warden.list",
  input: z.object({}),
  output: z.object({
    now: z.number(),
    tasks: z.array(taskViewSchema),
    settings: settingsSchema.nullable(),
    settingsError: z.string().nullable(),
    /** Base URL of the MCP endpoint, or why it is not running. */
    endpoint: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
  }),
});

export const cancelTaskRpc = defineRpc({
  name: "warden.cancel",
  input: z.object({ taskId: z.string() }),
  output: z.object({}),
});

/** The `/warden` slash command: the raw text after the command name, for the current agent. */
export const commandRpc = defineRpc({
  name: "warden.command",
  input: z.object({ agentId: z.string(), args: z.string() }),
  output: z.object({ message: z.string() }),
});
