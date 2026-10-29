import { z } from "zod";
import type { HostTool } from "../tools";
import { UsageError } from "../tools";
import { DISABLED_NOTE, SUPERVISOR_LABEL, type Supervisor } from "./manager";

const supervisorOnly = { key: SUPERVISOR_LABEL, value: "1" };

export const INSTRUCTIONS = `The Factory Supervisor is the agent that watches the Factory itself (stuck runs with no PM, spawn failures, leases, extensions, config errors).

If it is disabled (setting supervisor.enabled=false) supervisor_ask and supervisor_status say so, and its notices go to the blueprints events.mailTo (else the supervisor reportTo).

It runs on demand: it is archived when the Factory is idle and created again when something needs it (the first answer then takes longer). Anyone can reach it: supervisor_ask(question) relays your question and returns its answer (or a queued/pending request id to poll with supervisor_ask_status); supervisor_status shows its state and stable agent id, which you can also steer directly with a normal agent message.

If you are the Supervisor: answer requests with supervisor_reply, keep what your next session needs with supervisor_note, restart a crashed extension with extension_restart (once per hour per extension; after that ask the user with inbox_ask), act on runs with blueprint_abort / blueprint_retry / blueprint_resume, and change roles or blueprints only through pull requests on their git source for the user to approve.`;

export function supervisorTools(supervisor: Supervisor): Omit<HostTool, "owner">[] {
  return [
    {
      name: "supervisor_ask",
      description:
        "Ask the Factory Supervisor a question about the Factory (runs, extensions, leases, config) and get its answer. Open to every agent. If it does not answer in time you get a request id to poll with supervisor_ask_status.",
      input: z.object({ question: z.string().min(1).max(4000) }),
      async run({ question }, ctx) {
        return supervisor.ask({ id: ctx.callerId, name: await ctx.nameOf(ctx.callerId) }, question);
      },
    },
    {
      name: "supervisor_ask_status",
      description: "The state and answer of a request made with supervisor_ask.",
      input: z.object({ request: z.string() }),
      run({ request }) {
        const r = supervisor.request(request);
        const status = supervisor.requestStatus(request);
        if (!r || !status) throw new UsageError(`No request "${request}".`);
        return { request: r.id, status, answer: r.answer };
      },
    },
    {
      name: "supervisor_status",
      description: "The Supervisor's state, its stable agent id (steer it by sending that agent a message), the problems it is watching and its last extension restarts. Open to every agent.",
      input: z.object({}),
      async run() {
        const s = await supervisor.status();
        if (s.state === "disabled") return { state: "disabled", note: DISABLED_NOTE };
        return { agent_id: s.agentId, state: s.state, error: s.error, started_at: s.startedAt, watching: s.issues.map((i) => i.text), last_digest_at: s.lastDigestAt, extension_restarts: s.restarts, flags: s.flags.map((f) => f.text), queued: s.queued, busy: s.busy.reasons };
      },
    },
    {
      name: "supervisor_reply",
      description: "Supervisor only: answer a request from another agent (the id is in the request message).",
      input: z.object({ request: z.string(), answer: z.string().min(1).max(8000) }),
      requiresLabel: supervisorOnly,
      run({ request, answer }) {
        const r = supervisor.reply(request, answer);
        return { request: r.id, delivered_to: r.fromName };
      },
    },
    {
      name: "supervisor_note",
      description:
        "Supervisor only: keep a note for your next session. You run on demand and are archived when the Factory is idle; the Factory keeps your notes (8 KB, oldest dropped first) and gives them back in the intro of the next session. Write one before you are archived (the Factory asks) and whenever you promise or wait for something.",
      input: z.object({ text: z.string().min(1).max(2000) }),
      requiresLabel: supervisorOnly,
      run({ text }) {
        return { saved: true, bytes: Buffer.byteLength(supervisor.note(text)) };
      },
    },
    {
      name: "extension_restart",
      description:
        "Supervisor only: ask a crashed or unreachable extension to restart itself (the extension must support it). At most once per hour per extension; a second request within the hour is refused, so ask the user through inbox_ask.",
      input: z.object({ id: z.string().describe("Extension id, for example release-trains.") }),
      requiresLabel: supervisorOnly,
      async run({ id }) {
        return { result: await supervisor.restartExtension(id) };
      },
    },
  ];
}

export const TOOL_NAMES_OPEN = ["supervisor_ask", "supervisor_ask_status", "supervisor_status"];
export const TOOL_NAMES_SUPERVISOR = ["supervisor_reply", "supervisor_note", "extension_restart"];
