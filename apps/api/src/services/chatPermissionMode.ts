/**
 * Shared permission-mode helpers — used by the HTTP chat route (composer toggle +
 * slash commands) and the channel dispatcher (slash commands over Telegram/Slack/
 * etc.). Keeping the slash grammar and acknowledgements in one place means a
 * channel and the web composer interpret `/ask` `/plan` `/auto` identically.
 */
import type { ChatPermissionMode } from '@agentis/core';

/**
 * System guidance injected on a Plan-mode turn. The hard guarantee is the
 * registry-level mutation block (executionMode 'plan'); this just steers the
 * model to produce a concrete, useful plan instead of acting. Shared so a plan
 * over a channel reads the same as one in the web composer.
 */
export const PLAN_MODE_SYSTEM_ADDENDUM = [
  'PLAN MODE',
  'The operator explicitly asked you to plan. You are the selected agent for this conversation; answer in your own role and expertise.',
  'Do not mutate workspace state in this turn. You may inspect existing state with read-only tools, but do not build, save, run, delete, patch, or otherwise change resources.',
  'Produce an intelligent, concrete plan for the requested outcome. Avoid generic placeholders. Use domain-specific phases, dependencies, risks, open questions, and verification criteria.',
  'When useful, wrap the readable implementation plan in <proposed_plan>...</proposed_plan>. Keep it readable markdown.',
  'For workflow, extension, app, or system design requests, also include a separate preview-only <architecture_canvas>...</architecture_canvas> block containing compact JSON: {"kind":"workflow|extension|app|system","nodes":[{"id":"trigger","title":"...","role":"trigger|agent|integration|validator|output|...","kind":"optional subtype","summary":"optional"}],"edges":[{"source":"trigger","target":"next","label":"optional"}],"groups":[{"id":"phase-1","title":"optional lane"}]}.',
  'The architecture_canvas is a visual preview only. Do not create or save the real workflow/app/extension in Plan mode.',
  'If the user asks for workflow design, the architecture canvas must describe the actual workflow architecture: trigger, data sources, specialist/agent steps, integrations, guardrails, outputs, and verification.',
].join('\n');

/**
 * Parse a leading slash command that switches the conversation's sticky
 * permission mode. `/ask` confirms mutations, `/plan` proposes before acting,
 * `/auto` (alias `/bypass`) runs freely; `/chat` and `/act` are legacy aliases
 * for `/ask`. Returns the new mode plus any remaining message text (so
 * `/plan build X` switches mode AND runs the task), or null when the message is
 * not a mode command.
 */
export function parseModeCommand(message: string): { mode: ChatPermissionMode; rest: string } | null {
  const m = message.match(/^\/(ask|plan|auto|bypass|act|chat)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const cmd = (m[1] ?? '').toLowerCase();
  const rest = (m[2] ?? '').trim();
  const mode: ChatPermissionMode = cmd === 'plan'
    ? 'plan'
    : cmd === 'auto' || cmd === 'bypass'
      ? 'auto'
      : 'ask';
  return { mode, rest };
}

/** Operator-facing acknowledgement when a slash command switches mode with no task. */
export const MODE_SWITCH_ACK: Record<ChatPermissionMode, string> = {
  ask: 'Ask mode is on. I’ll confirm with you before running a workflow or doing anything risky or hard to undo.',
  plan: 'Plan mode is on. I’ll propose a plan and wait for your go-ahead before acting.',
  auto: 'Auto mode is on. I’ll carry out actions without stopping to confirm. Send /ask to turn confirmations back on.',
};

/** Default task text when a mode command carries no message of its own. */
export function defaultTaskForMode(mode: ChatPermissionMode): string {
  return mode === 'plan' ? 'Plan the requested work.' : 'Continue.';
}
