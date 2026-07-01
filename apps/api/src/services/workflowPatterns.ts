/**
 * Workflow Pattern Library (WORKFLOW-DESIGN-10X Phase 4).
 *
 * The doctrine (Phase 1) NAMES the robust patterns; this is their concrete shape.
 * Each pattern is a small, spliceable graph fragment (node skeletons + edges,
 * including the reject/fallback/rollback branches) the agent retrieves via
 * agentis.workflow.patterns and adapts into the real graph — so it composes a
 * proven control-flow shape instead of reinventing (and forgetting) the gates.
 *
 * Fragments use pattern-local node ids; the agent re-ids and wires them into the
 * surrounding workflow. They are illustrative skeletons, not validated graphs.
 */

export interface PatternEdge {
  from: string;
  to: string;
  /** For a router branch, the safe-condition this edge represents. */
  branch?: string;
}

export interface PatternNode {
  id: string;
  /** Node kind (node.config.kind), e.g. http_request, router, evaluator, checkpoint. */
  kind: string;
  title: string;
  /** A config skeleton with the fields that matter for this pattern. */
  config: Record<string, unknown>;
}

export interface WorkflowPattern {
  id: string;
  title: string;
  /** The doctrine clause(s) this pattern satisfies. */
  doctrine: string;
  /** One line: when to reach for it. */
  when: string;
  nodes: PatternNode[];
  edges: PatternEdge[];
}

export const WORKFLOW_PATTERNS: WorkflowPattern[] = [
  {
    id: 'qualify-or-reject-loop',
    title: 'Qualify-or-reject loop',
    doctrine: 'D1',
    when: 'You fetch candidates and must screen them, rejecting the weak ones and trying the next instead of proceeding.',
    nodes: [
      { id: 'fetch', kind: 'browser', title: 'Fetch candidate', config: { kind: 'browser', operation: 'extract_text' } },
      { id: 'qualify', kind: 'agent_task', title: 'Qualify candidate', config: { kind: 'agent_task', agentRole: 'analyst', prompt: 'Score the candidate against the bar; output { pass: boolean, reason }.', outputKeys: ['pass'] } },
      { id: 'gate', kind: 'router', title: 'Qualified?', config: { kind: 'router', routingMode: 'first_match', branches: [{ condition: 'nodes["qualify"].pass == true' }, { condition: 'nodes["qualify"].pass == false' }] } },
    ],
    edges: [
      { from: 'fetch', to: 'qualify' },
      { from: 'qualify', to: 'gate' },
      { from: 'gate', to: 'fetch', branch: 'fail → re-fetch the next candidate' },
      { from: 'gate', to: '<continue>', branch: 'pass → proceed downstream' },
    ],
  },
  {
    id: 'fetch-with-fallback',
    title: 'Fetch with fallback + result check',
    doctrine: 'D3',
    when: 'An external fetch/scrape/API is flaky (rate limits, empty DOM, bad encoding) and a failure must not become silent empty input.',
    nodes: [
      { id: 'primary', kind: 'http_request', title: 'Primary fetch', config: { kind: 'http_request', method: 'GET', url: '{{trigger.url}}' } },
      { id: 'fallback', kind: 'browser', title: 'Fallback extractor', config: { kind: 'browser', operation: 'extract_text', url: '{{trigger.url}}' } },
      { id: 'verify', kind: 'evaluator', title: 'Usable result?', config: { kind: 'evaluator', targetPath: 'result', criteria: 'The fetched artifact is non-empty and usable.', passThreshold: 0.6 } },
    ],
    edges: [
      { from: 'primary', to: 'verify' },
      { from: 'primary', to: 'fallback', branch: 'on error edge → fallback extractor' },
      { from: 'fallback', to: 'verify' },
      { from: 'verify', to: '<continue>', branch: 'pass → use the artifact' },
    ],
  },
  {
    id: 'approval-before-irreversible',
    title: 'Approval before an irreversible action',
    doctrine: 'D2',
    when: 'The next step is irreversible/externally visible (deploy, publish, send, pay, delete) and a human should confirm first.',
    nodes: [
      { id: 'approve', kind: 'checkpoint', title: 'Human approval', config: { kind: 'checkpoint', approvalMode: 'manual' } },
      { id: 'action', kind: 'integration', title: 'Irreversible action', config: { kind: 'integration', integrationId: '', operationId: '', inputs: {} } },
    ],
    edges: [
      { from: 'approve', to: 'action', branch: 'approved → run the action' },
    ],
  },
  {
    id: 'validate-before-transition',
    title: 'Validate-then-rollback',
    doctrine: 'D6',
    when: 'After an irreversible action, confirm it actually worked (HTTP 200, build ok, file present) and roll back on failure.',
    nodes: [
      { id: 'action', kind: 'integration', title: 'Irreversible action', config: { kind: 'integration', integrationId: '', operationId: '', inputs: {} } },
      { id: 'validate', kind: 'evaluator', title: 'Action succeeded?', config: { kind: 'evaluator', targetPath: 'result', criteria: 'The action verifiably succeeded (e.g. live URL returns 200).', passThreshold: 0.7 } },
      { id: 'gate', kind: 'router', title: 'Ok?', config: { kind: 'router', routingMode: 'first_match', branches: [{ condition: 'nodes["validate"].pass == true' }, { condition: 'nodes["validate"].pass == false' }] } },
      { id: 'rollback', kind: 'integration', title: 'Rollback / cleanup', config: { kind: 'integration', integrationId: '', operationId: '', inputs: {} } },
    ],
    edges: [
      { from: 'action', to: 'validate' },
      { from: 'validate', to: 'gate' },
      { from: 'gate', to: '<commit>', branch: 'pass → commit state / mark done' },
      { from: 'gate', to: 'rollback', branch: 'fail → run the compensating rollback' },
    ],
  },
  {
    id: 'bounded-parallel-batch',
    title: 'Bounded parallel batch',
    doctrine: 'D5',
    when: 'You process N items and must cap fan-out instead of launching everything at once.',
    nodes: [
      { id: 'loop', kind: 'loop', title: 'Per-item work (bounded)', config: { kind: 'loop', itemsExpression: '{{nodes.fetch.items}}', maxConcurrency: 5, bodyWorkflowId: '', outputArrayKey: 'results', onIterationError: 'continue' } },
      { id: 'merge', kind: 'merge', title: 'Join results', config: { kind: 'merge', requiredInputs: 'all' } },
    ],
    edges: [
      { from: 'loop', to: 'merge' },
    ],
  },
  {
    id: 'convergence-loop',
    title: 'Convergence loop (iterate until done)',
    doctrine: 'D7',
    when: 'The goal is open-ended — refine/fix/research UNTIL a condition holds, a draft→critique→revise loop, or multi-runtime cooperation that must converge (Opus researches → Codex fixes → verify → repeat). The body is a SEPARATE cohort sub-workflow you build and reference by id.',
    nodes: [
      { id: 'cohort', kind: 'converge', title: 'Converge until goal met', config: { kind: 'converge', bodyWorkflowId: '<cohort sub-workflow id: research → fix → verify>', continuation: { type: 'judge', targetPath: 'output', criteria: 'The objective is fully and verifiably met (e.g. zero failing tests).' }, maxIterations: 8, stallPolicy: { window: 2 }, isolation: 'auto', preserve: 'discard' } },
    ],
    edges: [],
  },
  {
    id: 'stateful-cursor-dedup',
    title: 'Stateful cursor / dedup',
    doctrine: 'D4',
    when: 'A cron/listener workflow must process only NEW items and be idempotent across runs.',
    nodes: [
      { id: 'seen', kind: 'workflow_store', title: 'Read seen-set / cursor', config: { kind: 'workflow_store', operations: [{ op: 'get', key: 'seen', outputKey: 'seen' }] } },
      { id: 'work', kind: 'agent_task', title: 'Handle only new items', config: { kind: 'agent_task', agentRole: 'analyst', prompt: 'Process only items not already in the seen-set.', outputKeys: ['handled'] } },
      { id: 'commit', kind: 'workflow_store', title: 'Persist new cursor', config: { kind: 'workflow_store', operations: [{ op: 'set', key: 'seen', value: '{{nodes.work.handled}}' }] } },
    ],
    edges: [
      { from: 'seen', to: 'work' },
      { from: 'work', to: 'commit' },
    ],
  },
];

const BY_ID = new Map(WORKFLOW_PATTERNS.map((p) => [p.id, p]));

/** Patterns whose doctrine clause is implied by the request's robustness signals. */
export function suggestPatterns(signals: { qualifies?: boolean; approval?: boolean; validates?: boolean; irreversible?: boolean; batch?: boolean; recurring?: boolean; externalFetch?: boolean; iterative?: boolean }): WorkflowPattern[] {
  const want = new Set<string>();
  if (signals.qualifies) want.add('qualify-or-reject-loop');
  if (signals.externalFetch) want.add('fetch-with-fallback');
  if (signals.approval) want.add('approval-before-irreversible');
  if (signals.validates && signals.irreversible) want.add('validate-before-transition');
  if (signals.batch) want.add('bounded-parallel-batch');
  if (signals.recurring) want.add('stateful-cursor-dedup');
  if (signals.iterative) want.add('convergence-loop');
  return WORKFLOW_PATTERNS.filter((p) => want.has(p.id));
}

export function getWorkflowPattern(id: string): WorkflowPattern | undefined {
  return BY_ID.get(id);
}
