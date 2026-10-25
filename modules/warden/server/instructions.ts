/** Shown to agents through the MCP `instructions` field of the initialize result. */
export const INSTRUCTIONS = `Warden watches your long-running work and prompts you if you go quiet.

When to use it: before you start something that takes a while or that you wait on (a build, CI, a deploy, a review, a subagent), call warden_register(task, interval_minutes). The task says what you are doing or waiting for; Warden pings you about a minute after your turn ends without warden_done, so idle stops are caught fast. interval_minutes only matters for hangs while you are still running: it is how long you may stay silent, and values above the max (default 15 min) are clamped. You can omit it. Use until (ISO 8601) if the task has a natural deadline.

Tools:
- warden_register: register a task for yourself. Returns task_id.
- warden_update(task_id, note): record progress. Counts as activity and restarts the timer.
- warden_done(task_id, result): finish the task. Always call it when the work is done or abandoned, so you stop being prompted.
- warden_list: list your active tasks.
- warden_register_subagent(agent_id, task, interval_minutes): if you manage subagents, guard one of them; you are notified if it stays unresponsive.

A message starting with "Warden:" is an inactivity ping: your turn ended without warden_done, or you went silent too long. Reply by continuing the task, or call warden_update with where you are, or warden_done if it is finished. If you ignore several pings, your parent agent is notified.

Rules: keep one task per piece of work, pick an interval longer than your longest normal silent step, and do not register tasks for work you are actively doing in short turns.`;
