/**
 * Run failure analysis — grounded, deterministic "what went wrong & how to fix".
 *
 * The orchestrator should explain a failed run AUTOMATICALLY and USEFULLY — not
 * pop a "Diagnose" button that, when clicked, free-associates. So this analyzer
 * reads the REAL failure (the failed node + its actual engine error + its
 * config) and maps known error shapes to concrete, actionable fixes. Everything
 * here is derived from real run state — no model, no hallucination. An LLM may
 * later enrich the wording, but the facts come from here.
 */

import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowGraph, WorkflowNode, WorkflowRunState } from '@agentis/core';

export interface FailureDiagnosis {
  runId: string;
  failedNodeId: string | null;
  failedNodeTitle: string | null;
  nodeKind: string | null;
  error: string | null;
  /** Was the cause recognized (high-confidence, mapped) vs. a generic surface-through. */
  recognized: boolean;
  /** One-paragraph, plain-language explanation grounded in the real error. */
  explanation: string;
  /** Concrete, ordered fix steps. */
  fixes: string[];
}

interface Rule {
  match: RegExp;
  describe: (node: WorkflowNode | null, error: string) => { explanation: string; fixes: string[] };
}

const RULES: Rule[] = [
  {
    // A DELIBERATE policy/approval gate throw (`BLOCKED_*`). Must be FIRST:
    // these gates throw via a transform, so the generic expression rule below
    // would misdiagnose the workflow working-as-intended as a broken expression.
    match: /\bBLOCKED_[A-Z0-9_]{2,}\b/,
    describe: (node, error) => ({
      explanation: `“${title(node)}” is a policy/approval GATE and it deliberately blocked the run (${oneLine(error)}). This is the workflow working as intended — not a platform bug — and self-healing correctly leaves gates alone.`,
      fixes: [
        'Complete the approval this gate guards (fill the human-input form / resolve the pending approval with the required field values), then start a FRESH run — replaying from before the gate re-feeds the same unapproved data.',
        'If the gate should not block in this case, edit its condition with agentis.build_workflow { workflowId, patchDraft } and dry-run before re-running.',
      ],
    }),
  },
  {
    // transform/filter expression problems (syntax, blocked token, bad reference)
    match: /expression (evaluation failed|rejected)|Unexpected token|is not defined/i,
    describe: (node, error) => ({
      explanation: `The expression on “${title(node)}” couldn't be evaluated (${oneLine(error)}). Transform/filter expressions run in a sandbox with \`input\`, \`ctx\`, and context aliases like \`nodes\` / \`trigger\`.`,
      fixes: [
        'Open the node and check the expression: it can be a single expression `({ ... })` or a function body using `return`.',
        'Reference workflow data via `input.*`, `ctx.*`, or aliases like `nodes.*`, `trigger.*`, `scratchpad.*`, and `store.*` — not external globals.',
        'If it reads an upstream value, confirm that node runs before this one (see the canvas lint).',
      ],
    }),
  },
  {
    match: /INTEGRATION_CREDENTIAL_MISSING|requires a credential|credential '.*' not found|RESOURCE_NOT_FOUND.*credential|unauthor|401|403/i,
    describe: (node) => ({
      explanation: `The “${title(node)}” step needs credentials that aren't connected (or are invalid) in this workspace.`,
      fixes: [
        `Connect the account for this integration, then re-run.`,
        'You can store the key from the run prompt (it’s saved encrypted) or set it up in Settings → Integrations.',
      ],
    }),
  },
  {
    match: /VALIDATION_FAILED|missing (url|method|integrationId|operationId|prompt|expression|condition|key)/i,
    describe: (node, error) => ({
      explanation: `The “${title(node)}” step is missing required configuration (${oneLine(error)}).`,
      fixes: ['Open the node and fill the missing field flagged above, then re-run.'],
    }),
  },
  {
    match: /http_request failed|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|blocked private/i,
    describe: (node, error) => ({
      explanation: `The “${title(node)}” HTTP request couldn't reach its target (${oneLine(error)}).`,
      fixes: [
        'Check the URL is reachable and correct.',
        'If it targets a private/localhost host, that is blocked by default for safety.',
      ],
    }),
  },
];

function title(node: WorkflowNode | null): string {
  return node?.title || node?.id || 'the failed step';
}
function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

/**
 * Diagnose a failed run from its persisted state + graph. Returns null when the
 * run isn't found or didn't actually fail.
 */
export function analyzeRunFailure(db: AgentisSqliteDb, workspaceId: string, runId: string): FailureDiagnosis | null {
  const row = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();
  if (!row || row.workspaceId !== workspaceId) return null;
  const state = row.runState as unknown as WorkflowRunState | null;
  // The failed node is either a hard-failed node OR one that errored but was
  // "handled" by an error edge (ends COMPLETED but still carries an error) — the
  // COMPLETED_WITH_ERRORS case. Both need diagnosing.
  const handledErrorNodeId = state?.nodeStates
    ? Object.entries(state.nodeStates).find(([, n]) => Boolean(n?.error))?.[0] ?? null
    : null;
  const failedNodeId = state?.failedNodeIds?.[0] ?? handledErrorNodeId;
  const error = (failedNodeId && state?.nodeStates?.[failedNodeId]?.error) || null;

  let graph: WorkflowGraph | null = null;
  if (row.workflowId) {
    const wf = db.select().from(schema.workflows).where(eq(schema.workflows.id, row.workflowId)).get();
    graph = (wf?.graph as WorkflowGraph | undefined) ?? null;
  }
  const node = (failedNodeId && graph?.nodes.find((n) => n.id === failedNodeId)) || null;
  const nodeKind = (node?.config as { kind?: string } | undefined)?.kind ?? node?.type ?? null;

  if (!error) {
    return {
      runId, failedNodeId, failedNodeTitle: node?.title ?? null, nodeKind, error: null, recognized: false,
      explanation: failedNodeId
        ? `“${title(node)}” failed, but no error detail was recorded. Open the node to inspect its input.`
        : 'The run failed without a specific node error. Open the run to inspect its steps.',
      fixes: ['Open the run and inspect the failed step’s input/output.'],
    };
  }

  const rule = RULES.find((r) => r.match.test(error));
  if (rule) {
    const { explanation, fixes } = rule.describe(node, error);
    return { runId, failedNodeId, failedNodeTitle: node?.title ?? null, nodeKind, error, recognized: true, explanation, fixes };
  }

  return {
    runId, failedNodeId, failedNodeTitle: node?.title ?? null, nodeKind, error, recognized: false,
    explanation: `“${title(node)}” failed: ${oneLine(error)}.`,
    fixes: ['Open the node above to inspect its input, fix the cause, and re-run.'],
  };
}

/** Compact chat-ready summary string for the proactive failure card. */
export function diagnosisToCardBody(d: FailureDiagnosis): string {
  const lines = [d.explanation];
  if (d.fixes.length > 0) {
    lines.push('', 'To fix:');
    for (const f of d.fixes) lines.push(`• ${f}`);
  }
  return lines.join('\n');
}
