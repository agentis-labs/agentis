/**
 * ORGAN 2 (UNBREAKABLE-WORKFLOW): the INTENT CONTRACT — anti-green-washing.
 *
 * A workflow that runs "green" but no longer does what it is FOR is the deepest
 * failure mode: under pressure (a rate-limited scout, a failing extension), an
 * agent replaces the hard, load-bearing work with a static stub to make every
 * check pass. Every prior tool measured mechanics ("does it run?"), never intent
 * ("does it still do its job?"). This organ makes gutting VISIBLE and NAMED.
 *
 * Two deterministic, zero-false-positive checks:
 *  - APPROVAL INTEGRITY (always): an approval flag forced to `true` (`|| true`,
 *    constant) before an irreversible action — the exact `deploy-contract-input`
 *    `|| true` bug from the transcript.
 *  - CAPABILITY PRESERVATION (vs a stored manifest): an edit that drops the
 *    autonomous workers, external-fetch steps, integrations, or persistence the
 *    workflow was built to provide — the "replaced the Instagram scout with a
 *    stub" gutting.
 */
import type { WorkflowGraph, WorkflowNode } from '@agentis/core';

const AGENT_KINDS = new Set(['agent_task', 'agent_session', 'planner', 'agent_swarm', 'dynamic_swarm']);
const FETCH_KINDS = new Set(['browser', 'http_request']);
const PERSIST_KINDS = new Set(['data_mutate', 'knowledge_ingest', 'artifact_save']);

export interface IntentManifest {
  version: 1;
  goal?: string;
  capabilities: {
    /** autonomous agent workers (agent_task/session/planner/swarm) */
    agentWorkers: number;
    /** external discovery/fetch steps (browser + http_request) */
    externalFetch: number;
    /** integration slugs + extension slugs the workflow uses (sorted, unique) */
    integrations: string[];
    /** persistence steps (data_mutate + knowledge_ingest + artifact_save) */
    persistence: number;
  };
  createdAt: string;
}

export interface IntentViolation {
  code: 'AUTO_APPROVAL_BYPASS' | 'CAPABILITY_REMOVED';
  severity: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

function nodeKind(node: WorkflowNode): string {
  return String((node.config as { kind?: string } | undefined)?.kind ?? node.type ?? '');
}

/** Derive the capability signature of a graph (deterministic). */
export function deriveIntentManifest(graph: WorkflowGraph, goal?: string): IntentManifest {
  let agentWorkers = 0, externalFetch = 0, persistence = 0;
  const integrations = new Set<string>();
  for (const node of graph.nodes) {
    const kind = nodeKind(node);
    if (AGENT_KINDS.has(kind)) agentWorkers += 1;
    if (FETCH_KINDS.has(kind)) externalFetch += 1;
    if (PERSIST_KINDS.has(kind)) persistence += 1;
    const c = node.config as { kind?: string; integrationId?: unknown; extensionSlug?: unknown };
    if (kind === 'integration' && typeof c.integrationId === 'string' && c.integrationId.trim()) {
      integrations.add(c.integrationId.trim().toLowerCase());
    }
    if (kind === 'extension_task' && typeof c.extensionSlug === 'string' && c.extensionSlug.trim()) {
      integrations.add(`ext:${c.extensionSlug.trim().toLowerCase()}`);
    }
  }
  return {
    version: 1,
    ...(goal && goal.trim() ? { goal: goal.trim().slice(0, 400) } : {}),
    capabilities: { agentWorkers, externalFetch, integrations: [...integrations].sort(), persistence },
    createdAt: new Date().toISOString(),
  };
}

const APPROVAL_OR_TRUE_RE = /\b(approved?|authoriz(?:ed|e)|allow(?:ed)?|proceed|ok)\b\s*[:=][^,}]*\|\|\s*true\b/i;
const APPROVAL_CONST_TRUE_RE = /\b(approved?|authoriz(?:ed|e))\b\s*:\s*true\b/i;

/**
 * Integrity + capability-preservation violations. `prior` is the manifest stored
 * when the workflow was last built; omit it for a brand-new workflow (only the
 * always-on approval-integrity check runs then).
 */
export function checkIntentIntegrity(graph: WorkflowGraph, prior?: IntentManifest | null): IntentViolation[] {
  const out: IntentViolation[] = [];

  // 1. APPROVAL INTEGRITY — an approval forced to true bypasses a real decision.
  for (const node of graph.nodes) {
    if (nodeKind(node) !== 'transform') continue;
    const expr = (node.config as { expression?: unknown }).expression;
    if (typeof expr !== 'string') continue;
    if (APPROVAL_OR_TRUE_RE.test(expr) || APPROVAL_CONST_TRUE_RE.test(expr)) {
      out.push({
        code: 'AUTO_APPROVAL_BYPASS',
        severity: 'error',
        nodeId: node.id,
        message:
          `Node '${node.id}' forces approval to true (\`|| true\` or a constant), so an irreversible action can `
          + `be approved without a real decision. Compute approval from the actual gate/checkpoint result, not a constant.`,
      });
    }
  }

  // 2. CAPABILITY PRESERVATION — an edit must not silently hollow out the workflow.
  if (prior?.capabilities) {
    const now = deriveIntentManifest(graph).capabilities;
    const p = prior.capabilities;
    if (now.agentWorkers < p.agentWorkers) {
      out.push({
        code: 'CAPABILITY_REMOVED', severity: 'warning',
        message:
          `This edit removes ${p.agentWorkers - now.agentWorkers} autonomous agent worker(s) (was ${p.agentWorkers}, now ${now.agentWorkers}). `
          + `If real work was replaced with a static stub to make the run pass, that hollows out the workflow — restore the agent or confirm the intent genuinely changed.`,
      });
    }
    if (now.externalFetch < p.externalFetch) {
      out.push({
        code: 'CAPABILITY_REMOVED', severity: 'warning',
        message:
          `This edit removes ${p.externalFetch - now.externalFetch} external-fetch step(s) (browser/http). `
          + `If the discovery/scrape step was stubbed out, the workflow no longer performs its core job.`,
      });
    }
    const lost = p.integrations.filter((s) => !now.integrations.includes(s));
    if (lost.length > 0) {
      out.push({
        code: 'CAPABILITY_REMOVED', severity: 'warning',
        message: `This edit drops integration(s) the workflow was built to use: ${lost.join(', ')}.`,
      });
    }
    if (now.persistence < p.persistence) {
      out.push({
        code: 'CAPABILITY_REMOVED', severity: 'warning',
        message: `This edit removes ${p.persistence - now.persistence} persistence step(s) — results may no longer be saved to the datastore.`,
      });
    }
  }

  return out;
}
