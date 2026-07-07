import { randomUUID } from 'node:crypto';
import { desc, eq, and } from 'drizzle-orm';
import { normalizeRole, type AgentRole } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { SpecialistAgentService } from './specialistAgents.js';
import type { SpecialistMindService } from './specialistMindService.js';
import type { SpecialistProfileService } from './specialistProfileService.js';
import type { SpecialistRuntimeService, SpecialistRunRecord } from './specialistRuntimeService.js';

export type SpecialistTopology = 'direct' | 'supervisor' | 'sequential' | 'swarm' | 'hierarchical' | 'shadow';

export interface SpecialistRequestInput {
  task: string;
  modality?: string;
  desiredTopology?: SpecialistTopology;
  constraints?: Record<string, unknown>;
  callerAgentId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  materialize?: boolean;
  createRun?: boolean;
}

export interface SpecialistRouteResult {
  traceId: string;
  selectedRole: string;
  selectedAgentId: string | null;
  topology: SpecialistTopology;
  score: number;
  explanation: string;
  contextSummary: {
    domainMatch: number;
    abilityMatch: number;
    mindRelevance: number;
    toolAffordanceMatch: number;
    historicalQuality: number;
    freshness: number;
    estimatedCostPenalty: number;
    mindAtoms: string[];
    requiredAbilities: string[];
    tools: string[];
  };
  specialistRun: SpecialistRunRecord | null;
}

export interface SpecialistDemandRouterDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  specialists: SpecialistAgentService;
  profiles: SpecialistProfileService;
  mind?: SpecialistMindService;
  runtime: SpecialistRuntimeService;
}

interface CandidateScore {
  role: string;
  name: string;
  score: number;
  domainMatch: number;
  abilityMatch: number;
  mindRelevance: number;
  toolAffordanceMatch: number;
  historicalQuality: number;
  freshness: number;
  estimatedCostPenalty: number;
  mindAtoms: string[];
  requiredAbilities: string[];
  tools: string[];
}

export class SpecialistDemandRouter {
  constructor(private readonly deps: SpecialistDemandRouterDeps) {}

  async request(workspaceId: string, userId: string, input: SpecialistRequestInput): Promise<SpecialistRouteResult> {
    const task = input.task.trim();
    if (!task) throw new Error('specialist request requires a task');
    const candidates = await this.#scoreCandidates(workspaceId, task, input.modality ?? 'text');
    const selected = candidates[0] ?? await this.#fallbackCandidate(workspaceId, task, input.modality ?? 'text');
    const topology = input.desiredTopology ?? chooseTopology(task, selected, input.constraints ?? {});
    const def = this.deps.specialists.defForRole(workspaceId, selected.role as AgentRole);
    const profile = this.deps.profiles.ensureFromDef(workspaceId, def, userId);
    const materialize = input.materialize !== false;
    const agentId = materialize ? this.deps.specialists.ensureRole(workspaceId, userId, selected.role as AgentRole) : this.deps.specialists.resolveRole(workspaceId, selected.role as AgentRole);
    if (agentId) {
      this.deps.runtime.ensureInstance({
        workspaceId,
        role: selected.role,
        agentId,
        profileId: profile.id,
        mode: topology === 'shadow' ? 'shadow_eval' : 'durable',
        parentAgentId: input.callerAgentId ?? null,
      });
    }
    const traceId = randomUUID();
    const explanation = explainSelection(selected, topology);
    const contextSummary = {
      domainMatch: selected.domainMatch,
      abilityMatch: selected.abilityMatch,
      mindRelevance: selected.mindRelevance,
      toolAffordanceMatch: selected.toolAffordanceMatch,
      historicalQuality: selected.historicalQuality,
      freshness: selected.freshness,
      estimatedCostPenalty: selected.estimatedCostPenalty,
      mindAtoms: selected.mindAtoms,
      requiredAbilities: selected.requiredAbilities,
      tools: selected.tools,
    };
    this.deps.db.insert(schema.specialistRoutingDecisions).values({
      id: traceId,
      workspaceId,
      task,
      modality: input.modality ?? 'text',
      desiredTopology: input.desiredTopology ?? null,
      selectedRole: selected.role,
      selectedAgentId: agentId,
      topology,
      score: selected.score,
      explanation,
      contextSummary,
      constraints: input.constraints ?? {},
      createdBy: userId,
      createdAt: new Date().toISOString(),
    }).run();
    const specialistRun = input.createRun === false ? null : this.deps.runtime.recordPlannedRun({
      workspaceId,
      routingDecisionId: traceId,
      role: selected.role,
      agentId,
      topology,
      task,
      budgetPolicy: budgetPolicyFrom(input.constraints ?? {}),
      artifactPolicy: artifactPolicyFrom(task, input.constraints ?? {}),
      trace: [{ at: new Date().toISOString(), event: 'specialist_routed', summary: explanation, metadata: { score: selected.score, topology } }],
    });
    return { traceId, selectedRole: selected.role, selectedAgentId: agentId, topology, score: selected.score, explanation, contextSummary, specialistRun };
  }

  recent(workspaceId: string, limit = 20): Array<typeof schema.specialistRoutingDecisions.$inferSelect> {
    return this.deps.db.select().from(schema.specialistRoutingDecisions)
      .where(eq(schema.specialistRoutingDecisions.workspaceId, workspaceId))
      .orderBy(desc(schema.specialistRoutingDecisions.createdAt))
      .limit(limit)
      .all();
  }

  async #scoreCandidates(workspaceId: string, task: string, modality: string): Promise<CandidateScore[]> {
    const roles = new Set<string>();
    for (const profile of this.deps.profiles.list(workspaceId)) roles.add(profile.role);
    for (const agent of this.deps.specialists.list(workspaceId)) {
      if (agent.role) roles.add(normalizeRole(agent.role));
    }

    const scored: CandidateScore[] = [];
    for (const role of roles) {
      if (role === 'orchestrator' || role === 'manager') continue;
      const def = this.deps.specialists.defForRole(workspaceId, role as AgentRole);
      const domainMatch = lexicalScore(task, [role, def.name, def.description, def.systemPrompt, ...def.capabilityTags]);
      const atoms = await this.deps.mind?.retrieve(workspaceId, role, task, 4).catch(() => []) ?? [];
      const mindRelevance = atoms.length === 0 ? 0 : Math.min(1, atoms.length / 4 + lexicalScore(task, atoms.map((a) => a.content)) * 0.5);
      const toolAffordanceMatch = toolScore(task, def.tools.map(String), modality);
      const historicalQuality = this.#historicalQuality(workspaceId, role);
      const freshness = this.#freshness(workspaceId, role);
      const estimatedCostPenalty = topologyCostPenalty(task, def.defaultModel);
      const score = clamp(
        0.35 * domainMatch +
        0.20 * mindRelevance +
        0.20 * toolAffordanceMatch +
        0.12 * historicalQuality +
        0.08 * freshness -
        0.05 * estimatedCostPenalty,
      );
      scored.push({
        role,
        name: def.name,
        score,
        domainMatch,
        abilityMatch: 0,
        mindRelevance,
        toolAffordanceMatch,
        historicalQuality,
        freshness,
        estimatedCostPenalty,
        mindAtoms: atoms.map((a) => a.content.slice(0, 180)),
        requiredAbilities: [],
        tools: def.tools.map(String),
      });
    }
    return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  async #fallbackCandidate(workspaceId: string, task: string, modality: string): Promise<CandidateScore> {
    const role = inferRole(task);
    const def = this.deps.specialists.defForRole(workspaceId, role as AgentRole);
    return {
      role,
      name: def.name,
      score: 0.35,
      domainMatch: 0.5,
      abilityMatch: 0,
      mindRelevance: 0,
      toolAffordanceMatch: toolScore(task, def.tools.map(String), modality),
      historicalQuality: 0.5,
      freshness: 0.5,
      estimatedCostPenalty: 0.25,
      mindAtoms: [],
      requiredAbilities: [],
      tools: def.tools.map(String),
    };
  }

  #historicalQuality(workspaceId: string, role: string): number {
    const rows = this.deps.db.select({ score: schema.specialistEvalRuns.score }).from(schema.specialistEvalRuns)
      .where(and(eq(schema.specialistEvalRuns.workspaceId, workspaceId), eq(schema.specialistEvalRuns.role, normalizeRole(role))))
      .orderBy(desc(schema.specialistEvalRuns.createdAt))
      .limit(10)
      .all();
    if (rows.length === 0) return 0.5;
    return clamp(rows.reduce((sum, row) => sum + row.score, 0) / rows.length);
  }

  #freshness(workspaceId: string, role: string): number {
    const mind = this.deps.mind?.getMind(workspaceId, role);
    if (!mind || mind.sources.length === 0) return 0.4;
    const newest = Math.max(...mind.sources.map((s) => new Date(s.createdAt).getTime()).filter(Number.isFinite));
    if (!Number.isFinite(newest)) return 0.5;
    const ageDays = (Date.now() - newest) / 86_400_000;
    return clamp(ageDays <= 7 ? 1 : ageDays <= 30 ? 0.8 : ageDays <= 90 ? 0.6 : 0.4);
  }
}

function explainSelection(c: CandidateScore, topology: SpecialistTopology): string {
  const reasons = [
    c.domainMatch >= 0.35 ? 'domain language matched' : null,
    c.mindRelevance > 0 ? 'specialist mind had relevant atoms' : null,
    c.toolAffordanceMatch >= 0.35 ? 'tool affordances fit the request' : null,
  ].filter(Boolean);
  return `Selected ${c.name} (${c.role}) via ${topology} topology because ${reasons.join(', ') || 'it is the best available specialist profile'}.`;
}

function chooseTopology(task: string, candidate: CandidateScore, constraints: Record<string, unknown>): SpecialistTopology {
  if (constraints.shadow === true) return 'shadow';
  const lower = task.toLowerCase();
  if (/swarm|parallel|many specialists|compare approaches/.test(lower)) return 'swarm';
  if (/pipeline|then|handoff|publish|review/.test(lower)) return 'sequential';
  if (/team|manager|coordinate/.test(lower)) return 'supervisor';
  return candidate.score < 0.25 ? 'supervisor' : 'direct';
}

function inferRole(task: string): string {
  const lower = task.toLowerCase();
  if (/code|bug|test|typescript|react|frontend/.test(lower)) return 'coder';
  if (/review|security|risk|qa/.test(lower)) return 'reviewer';
  if (/research|market|source|url|web/.test(lower)) return 'researcher';
  if (/design|architecture|system|adr/.test(lower)) return 'architect';
  if (/write|copy|email|post|doc/.test(lower)) return 'writer';
  return 'planner';
}

function lexicalScore(task: string, fields: string[]): number {
  const taskTokens = tokenSet(task);
  if (taskTokens.size === 0) return 0;
  const candidateTokens = tokenSet(fields.join(' '));
  let hits = 0;
  for (const token of taskTokens) if (candidateTokens.has(token)) hits += 1;
  return clamp(hits / Math.max(4, taskTokens.size));
}

function toolScore(task: string, tools: string[], modality: string): number {
  const lower = `${task} ${modality}`.toLowerCase();
  const expected = new Set<string>();
  if (/web|url|site|research/.test(lower)) expected.add('web_search').add('read_url');
  if (/code|repo|file|diff|test|frontend|backend/.test(lower)) expected.add('read_file').add('search_code').add('run_code');
  if (/deploy|release|ci/.test(lower)) expected.add('call_workflow');
  if (/image|screenshot|visual/.test(lower)) expected.add('read_file');
  if (expected.size === 0) return 0.5;
  const have = new Set(tools);
  let hits = 0;
  for (const tool of expected) if (have.has(tool)) hits += 1;
  return clamp(hits / expected.size);
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function topologyCostPenalty(task: string, model: string): number {
  const lower = `${task} ${model}`.toLowerCase();
  let penalty = /deep|reason|gpt-4|sonnet|opus/.test(lower) ? 0.35 : 0.15;
  if (/swarm|parallel|many|all/.test(lower)) penalty += 0.25;
  return clamp(penalty);
}

function budgetPolicyFrom(constraints: Record<string, unknown>): Record<string, unknown> {
  return {
    maxTokens: numeric(constraints.maxTokens),
    maxDollars: numeric(constraints.maxDollars),
    maxDelegations: numeric(constraints.maxDelegations) ?? 3,
    maxDepth: numeric(constraints.maxDepth) ?? 2,
  };
}

function artifactPolicyFrom(task: string, constraints: Record<string, unknown>): Record<string, unknown> {
  return {
    artifactFirst: constraints.artifactFirst === true || task.length > 1200 || /report|document|implementation|codebase|long/.test(task.toLowerCase()),
    summarizeToCoordinator: true,
  };
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
