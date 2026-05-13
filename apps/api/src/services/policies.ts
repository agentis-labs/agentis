import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { evalCondition, SafeConditionError } from '../engine/SafeConditionParser.js';

export type PolicyEffect = 'allow' | 'deny' | 'require_approval';
export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export interface PolicyRule {
  condition?: string;
  decision?: PolicyDecision;
  reason?: string;
}

export interface EvaluatePolicyArgs {
  workspaceId: string;
  subjectKind?: string;
  subjectId?: string | null;
  input?: Record<string, unknown>;
  runId?: string | null;
  nodeId?: string | null;
}

export class PolicyService {
  constructor(private readonly db: AgentisSqliteDb) {}

  list(workspaceId: string) {
    return this.db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.workspaceId, workspaceId))
      .orderBy(desc(schema.policies.priority), desc(schema.policies.updatedAt))
      .all();
  }

  get(workspaceId: string, id: string) {
    const policy = this.db
      .select()
      .from(schema.policies)
      .where(and(eq(schema.policies.workspaceId, workspaceId), eq(schema.policies.id, id)))
      .get();
    if (!policy) throw new AgentisError('RESOURCE_NOT_FOUND', 'Policy not found');
    return policy;
  }

  create(args: {
    workspaceId: string;
    userId: string;
    name: string;
    description?: string | null;
    subjectKind?: string;
    subjectId?: string | null;
    effect?: PolicyEffect;
    rules?: PolicyRule[];
    status?: string;
    priority?: number;
  }) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.insert(schema.policies).values({
      id,
      workspaceId: args.workspaceId,
      userId: args.userId,
      name: args.name,
      description: args.description ?? null,
      subjectKind: args.subjectKind ?? 'workspace',
      subjectId: args.subjectId ?? null,
      effect: args.effect ?? 'allow',
      rules: args.rules ?? [],
      status: args.status ?? 'active',
      priority: args.priority ?? 0,
      lastEvaluatedAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.get(args.workspaceId, id);
  }

  update(workspaceId: string, id: string, patch: Partial<{
    name: string;
    description: string | null;
    subjectKind: string;
    subjectId: string | null;
    effect: PolicyEffect;
    rules: PolicyRule[];
    status: string;
    priority: number;
  }>) {
    this.get(workspaceId, id);
    const now = new Date().toISOString();
    this.db.update(schema.policies).set({ ...patch, updatedAt: now }).where(eq(schema.policies.id, id)).run();
    return this.get(workspaceId, id);
  }

  evaluate(args: EvaluatePolicyArgs) {
    const subjectKind = args.subjectKind ?? 'workspace';
    const input = args.input ?? {};
    const candidates = this.list(args.workspaceId)
      .filter((policy) => policy.status === 'active')
      .filter((policy) => policy.subjectKind === 'workspace' || policy.subjectKind === subjectKind)
      .filter((policy) => !policy.subjectId || policy.subjectId === args.subjectId);

    let decision: PolicyDecision = 'allow';
    let matchedPolicy: (typeof candidates)[number] | null = null;
    let reason = 'No active policy denied the request';

    for (const policy of candidates) {
      const rules = parseRules(policy.rules);
      const matchedRule = rules.find((rule) => matchesRule(rule, input));
      if (!matchedRule && rules.length > 0) continue;
      matchedPolicy = policy;
      decision = matchedRule?.decision ?? normalizeDecision(policy.effect);
      reason = matchedRule?.reason ?? `Matched policy ${policy.name}`;
      if (decision !== 'allow') break;
    }

    const now = new Date().toISOString();
    if (matchedPolicy) {
      this.db.update(schema.policies).set({ lastEvaluatedAt: now, updatedAt: matchedPolicy.updatedAt }).where(eq(schema.policies.id, matchedPolicy.id)).run();
    }
    const decisionId = randomUUID();
    this.db.insert(schema.policyDecisions).values({
      id: decisionId,
      workspaceId: args.workspaceId,
      policyId: matchedPolicy?.id ?? null,
      runId: args.runId ?? null,
      nodeId: args.nodeId ?? null,
      subjectKind,
      subjectId: args.subjectId ?? null,
      decision,
      reason,
      input,
      createdAt: now,
    }).run();
    return { decision, reason, policy: matchedPolicy, decisionId };
  }

  listDecisions(workspaceId: string, limit = 100) {
    return this.db
      .select()
      .from(schema.policyDecisions)
      .where(eq(schema.policyDecisions.workspaceId, workspaceId))
      .orderBy(desc(schema.policyDecisions.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500))
      .all();
  }
}

function parseRules(value: unknown): PolicyRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PolicyRule => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function matchesRule(rule: PolicyRule, input: Record<string, unknown>): boolean {
  if (!rule.condition?.trim()) return true;
  try {
    return evalCondition(rule.condition, { input, inputs: input });
  } catch (err) {
    if (err instanceof SafeConditionError) return false;
    throw err;
  }
}

function normalizeDecision(effect: string): PolicyDecision {
  if (effect === 'deny' || effect === 'require_approval') return effect;
  return 'allow';
}