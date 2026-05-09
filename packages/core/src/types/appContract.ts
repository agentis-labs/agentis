/**
 * App Runtime Contract — AGENT-FIRST-ARCHITECTURE.md Plane 1.
 *
 * Loaded at run start, snapshotted to `app_runtime_contracts`, and consulted
 * at every dispatch / retry / replan / completion / evaluator stage. This is
 * engine policy — not UI hint, not documentation.
 *
 * Spec: docs/AGENTIS-APP-FORMAT.md §3.
 */

export interface AppOutputDeclaration {
  key: string;
  description: string;
  /** Optional JSON Schema (validated by the engine at terminal transitions). */
  schema?: unknown;
  required: boolean;
}

export interface AppSuccessPolicy {
  completionRule: 'all_required_outputs' | 'evaluator_pass' | 'workflow_terminal';
  /** 0..1, used when completionRule === 'evaluator_pass'. */
  minEvaluatorScore?: number;
}

export interface AppBudgetPolicy {
  maxCostCentsPerRun?: number;
  maxCostCentsPerDay?: number;
  /** strict: hard fail at cap. warn: log + activity. adaptive: degrade. */
  costMode: 'strict' | 'warn' | 'adaptive';
  /** Fraction (0..1) of run budget reserved for replay. Default 0.2. */
  replayReserveFraction?: number;
}

export interface AppReliabilityPolicy {
  maxTurnsPerAgentTask?: number;
  maxReplansPerRun?: number;
  replayStrategy: 'suffix_only' | 'checkpoint' | 'full';
  onContractViolation: 'fail' | 'escalate' | 'degrade';
}

export interface AppEscalationPolicy {
  /** Capability tags that always require a human approval. */
  requireApprovalFor: string[];
  pauseOnAmbiguity: boolean;
  pauseOnBudgetRisk: boolean;
}

export interface AppDegradationPolicy {
  fallbackModelClass?: 'small' | 'medium' | 'large';
  allowPartialOutputs: boolean;
  /** When allowPartialOutputs, the minimum required output keys. */
  minOutputSet?: string[];
}

export interface AppRuntimeContract {
  outputs: AppOutputDeclaration[];
  successPolicy: AppSuccessPolicy;
  budgetPolicy: AppBudgetPolicy;
  reliabilityPolicy: AppReliabilityPolicy;
  escalationPolicy: AppEscalationPolicy;
  degradationPolicy: AppDegradationPolicy;
}

/** Conservative defaults applied when an app declares no contract. */
export const DEFAULT_RUNTIME_CONTRACT: AppRuntimeContract = {
  outputs: [],
  successPolicy: { completionRule: 'workflow_terminal' },
  budgetPolicy: { costMode: 'warn', replayReserveFraction: 0.2 },
  reliabilityPolicy: {
    maxTurnsPerAgentTask: 12,
    maxReplansPerRun: 2,
    replayStrategy: 'suffix_only',
    onContractViolation: 'fail',
  },
  escalationPolicy: {
    requireApprovalFor: [],
    pauseOnAmbiguity: false,
    pauseOnBudgetRisk: false,
  },
  degradationPolicy: { allowPartialOutputs: false },
};

// ────────────────────────────────────────────────────────────
// Evaluators (Plane 6) — must declare a tier
// ────────────────────────────────────────────────────────────

export type EvaluatorTier = 'schema' | 'rule' | 'rubric' | 'llm';

export interface AppEvaluatorRule {
  id: string;
  /** Safe-condition expression evaluated by SafeConditionParser. */
  condition: string;
  errorCode: string;
  errorMessage?: string;
}

export interface AppEvaluatorRubricExample {
  input: unknown;
  output: unknown;
  verdict: 'pass' | 'fail';
  score?: number;
}

export interface AppEvaluatorBinding {
  id: string;
  appliesTo: { kind: 'agent_task' | 'terminal_output'; ref: string };
  tier: EvaluatorTier;
  schema?: unknown;
  rules?: AppEvaluatorRule[];
  rubric?: { examples: AppEvaluatorRubricExample[]; minScore?: number };
  llm?: {
    modelClass: 'small' | 'medium' | 'large';
    promptTemplate: string;
    extractScoreFrom?: string;
  };
}

// ────────────────────────────────────────────────────────────
// Policy decisions (Plane 6) — runtime control verdicts
// ────────────────────────────────────────────────────────────

export type PolicyDecision = 'allow' | 'warn' | 'pause' | 'escalate' | 'degrade' | 'fail';

export type PolicyTrigger =
  | 'dispatch'
  | 'retry'
  | 'replan'
  | 'terminal'
  | 'budget'
  | 'escalation';

export interface PolicyEvaluation {
  trigger: PolicyTrigger;
  decision: PolicyDecision;
  reason: string;
  context: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────
// Multi-turn agent_task — Plane 3
// ────────────────────────────────────────────────────────────

export interface AgentTaskRuntimePolicy {
  /** When true, the engine drives the multi-turn loop; otherwise legacy single-shot. */
  multiTurn?: boolean;
  /** Hard cap on turns. Defaults to reliability policy maxTurnsPerAgentTask. */
  maxTurns?: number;
  /** Behavior when the cap is reached. */
  onTurnCap?: 'escalate' | 'fail' | 'replan';
  requireStructuredOutput?: boolean;
  outputSchema?: unknown;
  evaluatorRef?: string;
  modelClass?: 'small' | 'medium' | 'large';
  costTier?: 'cheap' | 'balanced' | 'power';
}

export interface TurnStateRecord {
  runId: string;
  nodeId: string;
  turnIndex: number;
  summary: string | null;
  payload: Record<string, unknown>;
  blockers: string[];
  costCents: number;
  createdAt: string;
}

// ────────────────────────────────────────────────────────────
// Cost compiler (Plane 4)
// ────────────────────────────────────────────────────────────

export type NodeCostClass = 'deterministic' | 'cheap_model' | 'expensive_model' | 'unknown';

export interface NodeCostAnnotation {
  nodeId: string;
  costClass: NodeCostClass;
  estimatedCostCentsMin: number;
  estimatedCostCentsMax: number;
  /** Why this class was chosen. */
  rationale: string;
}

export interface GraphCostShape {
  graphRevision: number;
  nodes: NodeCostAnnotation[];
  estimatedTotalCentsMin: number;
  estimatedTotalCentsMax: number;
  /** Counterfactual: estimated cost under naive LLM-mediated orchestration. */
  naiveBaselineCents: number;
  /** Estimated savings (naiveBaseline - estimatedMax), clamped at 0. */
  estimatedSavedCents: number;
  warnings: string[];
}
