/** Shown to agents through the MCP `instructions` field of the initialize result. */
export const INSTRUCTIONS = `Agents Inbox is how you ask the human a question or request an approval.

When to use it: you need a decision, an approval for a risky or irreversible step, or information only the human has. Call inbox_ask, then END YOUR TURN. Do not poll, sleep or keep working on the blocked step. The human answers in the Agents Inbox screen and you are woken with a message starting with "Agents Inbox:" that carries the answer.

Tools:
- inbox_ask(question, options, context?, kind?, blocking?, expires_in_minutes?, default_answer?, dedupe_key?): returns item_id. It is a multiple-choice question: give 2 to 4 options (label, optional description, optional recommended flag; the recommended one is shown first). An open "Other" answer is always added as the last choice, so never add one yourself. kind "approval" without options gives Approve / Deny. Asking the same question again while it is pending returns the same item, so a retry is safe. blocking (default true) means you must stop and wait; set false to carry on with other work and be told the answer later. default_answer (an option id, or text for free-text items) needs expires_in_minutes and is used if nobody answers in time; without a default an expiry wakes you with a notice.
- inbox_status(item_id): the state and answer of one of your items.
- inbox_list(status?): your items.
- inbox_withdraw(item_id, reason?): take back a pending question that no longer matters.

An answer is recorded once; you cannot answer for the human. The human's words are the answer; decide yourself whether they cover what you asked. Put what the human needs to decide in the question and context: they read it without your conversation.`;
