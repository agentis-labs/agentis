/**
 * Shared permission-mode helpers — used by the HTTP chat route (composer toggle +
 * slash commands) and the channel dispatcher (slash commands over Telegram/Slack/
 * etc.). Keeping the slash grammar and acknowledgements in one place means a
 * channel and the web composer interpret `/ask` `/plan` `/auto` identically.
 */
import type { AgentAdapter, ChatPermissionMode } from '@agentis/core';
import { extractAgentPlan, parseArchitectureCanvas, planMissingArchitectureCanvas } from '@agentis/core';
import { completeStructuredViaAdapter } from './structuredCompleter.js';

/**
 * System guidance injected on a Plan-mode turn. The hard guarantee is the
 * registry-level mutation block (executionMode 'plan'); this just steers the
 * model to produce a concrete, useful plan instead of acting. Shared so a plan
 * over a channel reads the same as one in the web composer.
 *
 * `<proposed_plan>` and, for design-shaped requests, `<architecture_canvas>`
 * are REQUIRED, not optional — a model that skips them used to silently
 * degrade to a plain-text reply with no visual plan canvas. `repairArchitectureCanvas`
 * below is the backstop for when a model still skips it despite this.
 */
export const PLAN_MODE_SYSTEM_ADDENDUM = [
  'PLAN MODE',
  'The operator explicitly asked you to plan. You are the selected agent for this conversation; answer in your own role and expertise.',
  'Do not mutate workspace state in this turn. You may inspect existing state with read-only tools, but do not build, save, run, delete, patch, or otherwise change resources.',
  'Produce an intelligent, concrete plan for the requested outcome. Avoid generic placeholders. Use domain-specific phases, dependencies, risks, open questions, and verification criteria.',
  'You MUST wrap the readable implementation plan in <proposed_plan>...</proposed_plan>. Keep it readable markdown. This is required on every plan-mode turn that proposes a course of action, not optional.',
  'For workflow, extension, app, or system design requests, you MUST ALSO include a separate preview-only <architecture_canvas>...</architecture_canvas> block immediately after </proposed_plan>, containing compact JSON (no markdown fences, no trailing commentary) in exactly this shape: {"kind":"workflow|extension|app|system","nodes":[{"id":"trigger","title":"...","role":"trigger|agent|integration|validator|output|...","kind":"optional subtype","summary":"optional"}],"edges":[{"source":"trigger","target":"next","label":"optional"}],"groups":[{"id":"phase-1","title":"optional lane"}]}.',
  'Worked example for "design a workflow that scrapes a site daily and emails a digest":',
  '<proposed_plan>\n1. **Trigger** — daily cron at 07:00.\n2. **Scrape** — agent_task fetches and extracts the target page.\n3. **Summarize** — agent_task drafts the digest.\n4. **Send** — integration node emails the digest.\n\nRisks: site layout changes break extraction; add a validator step.\n</proposed_plan>',
  '<architecture_canvas>{"kind":"workflow","nodes":[{"id":"trigger","title":"Daily 07:00","role":"trigger"},{"id":"scrape","title":"Scrape site","role":"agent","summary":"Fetch + extract content"},{"id":"validate","title":"Validate content","role":"validator"},{"id":"summarize","title":"Draft digest","role":"agent"},{"id":"send","title":"Email digest","role":"integration"}],"edges":[{"source":"trigger","target":"scrape"},{"source":"scrape","target":"validate"},{"source":"validate","target":"summarize"},{"source":"summarize","target":"send"}]}</architecture_canvas>',
  'The architecture_canvas is a visual preview only. Do not create or save the real workflow/app/extension in Plan mode.',
  'If the user asks for workflow design, the architecture canvas must describe the actual workflow architecture: trigger, data sources, specialist/agent steps, integrations, guardrails, outputs, and verification.',
].join('\n');

/** Keyword heuristic for "this plan-mode request is design-shaped" — matches
 * the addendum's own "workflow, extension, app, or system design" language.
 * Deliberately conservative: only gates the extra repair completion below, not
 * anything user-visible, so a false negative just skips a repair attempt.
 */
const DESIGN_SHAPED_RE = /\b(workflow|extension|app|automation|architecture|system|pipeline|integration)\b/i;

function looksDesignShaped(userMessage: string): boolean {
  return DESIGN_SHAPED_RE.test(userMessage);
}

/**
 * Backstop for a plan-mode turn that produced `<proposed_plan>` but skipped or
 * malformed `<architecture_canvas>` on a design-shaped request. Issues ONE
 * cheap follow-up structured completion (reusing the same `completeStructuredViaAdapter`
 * pattern the workflow synthesizer uses) asking the model to emit just the
 * architecture JSON for the plan it already wrote, then splices a valid
 * `<architecture_canvas>` block into the text. Returns `text` unchanged (never
 * throws, never corrupts the reply) if the plan is missing, the request isn't
 * design-shaped, or the repair attempt itself fails.
 */
export async function repairArchitectureCanvas(
  adapter: AgentAdapter,
  text: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!planMissingArchitectureCanvas(text)) return text;
  if (!looksDesignShaped(userMessage)) return text;
  const plan = extractAgentPlan(text);
  if (!plan) return text;
  if (!adapter.chat) return text;

  const { value } = await completeStructuredViaAdapter<Record<string, unknown>>(adapter, {
    system: 'You output ONLY a single strict JSON object — no prose, no markdown fences.',
    user: [
      'The following implementation plan was just written for a design request. Produce the architecture_canvas JSON for it.',
      'Shape: {"kind":"workflow|extension|app|system","nodes":[{"id":"...","title":"...","role":"trigger|agent|integration|validator|output|...","kind":"optional subtype","summary":"optional"}],"edges":[{"source":"...","target":"...","label":"optional"}],"groups":[{"id":"...","title":"optional lane"}]}',
      'Describe the actual architecture implied by the plan below: trigger, data sources, specialist/agent steps, integrations, guardrails, outputs, verification.',
      '',
      'PLAN:',
      plan.planText,
    ].join('\n'),
    maxAttempts: 2,
    signal,
  });
  if (!value) return text;
  const architecture = parseArchitectureCanvas(JSON.stringify(value));
  if (!architecture) return text;

  const canvasBlock = `<architecture_canvas>${JSON.stringify(architecture)}</architecture_canvas>`;
  const proposedPlanClose = '</proposed_plan>';
  const insertAt = text.indexOf(proposedPlanClose);
  if (insertAt === -1) return text;
  const at = insertAt + proposedPlanClose.length;
  return `${text.slice(0, at)}\n\n${canvasBlock}${text.slice(at)}`;
}

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
