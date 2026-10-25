export const SCOPE_ENV = "PASEO_INBOX";
export const TOOL_NAMES = ["inbox_ask", "inbox_status", "inbox_list", "inbox_withdraw", "inbox_pending", "inbox_answer"];

export function scopeApplies(scope: "all" | "opt-in", env: Record<string, string> | undefined): boolean {
  const value = env?.[SCOPE_ENV]?.toLowerCase();
  if (value === "off") return false;
  return scope === "all" || value === "on";
}

export const NOTE =
  "Agents Inbox: when you need a human decision, an approval, or information only the user has, call inbox_ask " +
  "as a multiple-choice question with 2 to 4 options (an open Other answer is added for you; mark the one you recommend), blocking by default, then end your turn. The answer arrives as a message starting with \"Agents Inbox:\". " +
  "Do not guess or proceed on risky steps while a blocking question is pending.";
