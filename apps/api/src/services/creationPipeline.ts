/**
 * Creation Pipeline — ORCHESTRATOR-CREATION-10X §2 (Stages 1-5).
 *
 * The intelligence that makes `build_workflow` produce operationally-valid graphs
 * instead of one-node collapses. Pure, composable functions over a small deps
 * surface so each stage is independently testable:
 *
 *   buildWorkspaceInventory  — "what can we actually build here?" (Stage 2)
 *   classifyIntent           — archetype + required/missing integrations (Stage 3)
 *   assembleCreationBrief    — caller domain + inventory + classification (Stages 1+4)
 *   preflightAndEnrich       — bind credentials, ensure terminal output, warn (Stage 5)
 */

import { and, eq } from 'drizzle-orm';
import {
  SPECIALIST_AGENTS,
  ROLE_TOOLS,
  type AgentRole,
  type AgentTool,
  type WorkflowGraph,
  type WorkflowNode,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { KnowledgeBaseService } from './knowledgeBase.js';
import type { WorkspaceIntelligenceService } from './workspaceIntelligence.js';
import type { AgentLibraryService } from './agentLibrary.js';

/** Minimal deps surface — `ToolHandlerDeps` satisfies this. */
export interface CreationDeps {
  db: AgentisSqliteDb;
  knowledgeBases?: KnowledgeBaseService;
  workspaceIntelligence?: WorkspaceIntelligenceService;
  agentLibrary?: AgentLibraryService;
}

// Known native connector slugs (ConnectorRegistry) + high-demand roadmap ones.
const CONNECTOR_SLUGS = ['slack', 'gmail', 'github', 'sheets', 'http', 'webhook', 'notion', 'airtable', 'jira', 'linear', 'discord', 'telegram'] as const;

// Natural-language → connector slug, for intent extraction.
const INTEGRATION_HINTS: Array<[RegExp, string]> = [
  [/\bgmail|email|inbox|e-mail\b/, 'gmail'],
  [/\bslack\b/, 'slack'],
  [/\bgithub|pull request|\bpr\b|commit|repo\b/, 'github'],
  [/\bsheet|spreadsheet|google sheets\b/, 'sheets'],
  [/\bnotion\b/, 'notion'],
  [/\bairtable\b/, 'airtable'],
  [/\bjira\b/, 'jira'],
  [/\blinear\b/, 'linear'],
  [/\bdiscord\b/, 'discord'],
  [/\btelegram\b/, 'telegram'],
];

export interface WorkspaceInventory {
  availableAgents: Array<{ id: string; name: string; role: string | null; adapterType: string; status: string; capabilityTags: string[] }>;
  configuredCredentials: Array<{ id: string; name: string; integrationSlug: string }>;
  availableSkills: string[];
  knowledgeBases: Array<{ id: string; name: string }>;
  /**
   * §G6 — top Brain passages relevant to the creation request, so the synthesis
   * LLM can verify a `knowledge` node is warranted, pick the right base, and
   * choose a static query that actually returns content. Empty when no request
   * was supplied or no Brain content matched.
   */
  knowledgeExcerpts: Array<{ knowledgeBaseId: string; content: string; score: number }>;
  wireableIntegrations: string[];
  specialistRoles: Array<{ role: AgentRole | string; tools: string[]; defaultModel: string; custom?: boolean }>;
  workspaceContext: string;
}

/**
 * Stage 2 — assemble the concrete "what can we build" inventory for a workspace.
 * Pass `request` (the user's creation description) to additionally retrieve
 * relevant Brain passages (§G6).
 */
export async function buildWorkspaceInventory(deps: CreationDeps, workspaceId: string, request?: string): Promise<WorkspaceInventory> {
  const agents = deps.db
    .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, adapterType: schema.agents.adapterType, status: schema.agents.status, capabilityTags: schema.agents.capabilityTags })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();

  const creds = deps.db
    .select({ id: schema.credentials.id, name: schema.credentials.name, credentialType: schema.credentials.credentialType })
    .from(schema.credentials)
    .where(eq(schema.credentials.workspaceId, workspaceId))
    .all();
  const configuredCredentials = creds.map((c) => ({ id: c.id, name: c.name, integrationSlug: inferSlug(c.credentialType, c.name) }));

  const dbSkills = deps.db
    .select({ slug: schema.skills.slug })
    .from(schema.skills)
    .where(eq(schema.skills.workspaceId, workspaceId))
    .all()
    .map((s) => s.slug);

  const knowledgeBases = (deps.knowledgeBases?.listKnowledgeBases(workspaceId) ?? []).map((k) => ({ id: k.id, name: k.name }));

  // §G6 — retrieve Brain passages relevant to the request so synthesis can wire
  // knowledge nodes against real content. Best-effort; never blocks creation.
  const knowledgeExcerpts: WorkspaceInventory['knowledgeExcerpts'] = [];
  const probe = request?.trim();
  if (probe && deps.knowledgeBases && knowledgeBases.length > 0) {
    try {
      const query = probe.slice(0, 128);
      const hits = knowledgeBases
        .flatMap((kb) => deps.knowledgeBases!.search({ workspaceId, knowledgeBaseId: kb.id, query, topK: 5 })
          .map((h) => ({ knowledgeBaseId: kb.id, content: h.content, score: h.score })))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      knowledgeExcerpts.push(...hits);
    } catch { /* best effort */ }
  }

  const wireableIntegrations = [...new Set(configuredCredentials.map((c) => c.integrationSlug).filter((s) => (CONNECTOR_SLUGS as readonly string[]).includes(s)))];

  let workspaceContext = '';
  try {
    workspaceContext = (await deps.workspaceIntelligence?.buildContextBlock(workspaceId)) ?? '';
  } catch { /* best effort */ }

  // Custom roles from agents/custom/*.md expand the casting vocabulary (Principle #11).
  const specialistRoles: WorkspaceInventory['specialistRoles'] = SPECIALIST_AGENTS.map((s) => ({ role: s.role, tools: ROLE_TOOLS[s.role], defaultModel: s.defaultModel }));
  try {
    for (const cr of (await deps.agentLibrary?.listCustomRoles(workspaceId)) ?? []) {
      if (!specialistRoles.some((r) => r.role === cr.role)) specialistRoles.push({ role: cr.role, tools: cr.tools, defaultModel: cr.defaultModel, custom: true });
    }
  } catch { /* best effort */ }

  return {
    availableAgents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role, adapterType: a.adapterType, status: a.status, capabilityTags: Array.isArray(a.capabilityTags) ? (a.capabilityTags as string[]) : [] })),
    configuredCredentials,
    availableSkills: [...new Set([...dbSkills, ...['tdd-protocol', 'owasp-checklist', 'aarrr-framework', 'statistical-testing', 'adr-format', 'code-review-rubric', 'api-design-guidelines']])],
    knowledgeBases,
    knowledgeExcerpts,
    wireableIntegrations,
    specialistRoles,
    workspaceContext: workspaceContext.slice(0, 3000),
  };
}

export type WorkflowArchetype = 'atomic' | 'pipeline' | 'orchestrated' | 'enterprise';

export interface IntentClassification {
  archetype: WorkflowArchetype;
  triggerType: 'manual' | 'cron' | 'webhook';
  requiredIntegrations: string[];
  missingCredentials: string[];
  estimatedNodeCount: number;
  requiresPlanConfirmation: boolean;
}

/** Stage 3 — classify the request + flag missing dependencies. Deterministic, no LLM. */
export function classifyIntent(description: string, inventory: WorkspaceInventory): IntentClassification {
  const lower = description.toLowerCase();

  const requiredIntegrations = [...new Set(INTEGRATION_HINTS.filter(([re]) => re.test(lower)).map(([, slug]) => slug))];
  const missingCredentials = requiredIntegrations.filter((slug) => !inventory.wireableIntegrations.includes(slug));

  const triggerType: IntentClassification['triggerType'] =
    /\bwebhook|incoming (request|post)|when .* (arrives|received)\b/.test(lower) ? 'webhook'
      : /\bevery|daily|weekly|hourly|each (morning|day|week)|schedule|cron|monitor|continuously|constantly\b/.test(lower) ? 'cron'
        : 'manual';

  // Signal counting → complexity. Leading \b only — these are prefixes
  // ("summari" must match "summarize"), so no trailing boundary.
  const sourceSignals = (lower.match(/\b(scrape|fetch|gather|collect|monitor|listen|pull|source|feed|registr|board|thread|api)/g) ?? []).length;
  const processingSignals = (lower.match(/\b(summari|analy|score|rank|classif|transform|extract|distil|map|reverse|deduplicat|filter|generat|draft|compile)/g) ?? []).length;
  const deliverySignals = (lower.match(/\b(send|email|post|notify|alert|publish|deliver|signal|dashboard|queue|calendar|inbox)/g) ?? []).length;
  const ensembleSignals = (lower.match(/\b(ensemble|multiple (models|llms|agents)|specialized|swarm|parallel|several)/g) ?? []).length;

  const estimatedNodeCount = Math.max(2, sourceSignals + processingSignals + deliverySignals + requiredIntegrations.length + 1);
  const score = sourceSignals + processingSignals * 1.2 + deliverySignals + ensembleSignals * 2 + requiredIntegrations.length;

  let archetype: WorkflowArchetype;
  if (ensembleSignals >= 2 || score >= 12 || requiredIntegrations.length >= 3) archetype = 'enterprise';
  else if (score >= 6 || (sourceSignals >= 1 && processingSignals >= 1 && deliverySignals >= 1)) archetype = 'orchestrated';
  else if (processingSignals >= 1 || sourceSignals >= 1) archetype = 'pipeline';
  else archetype = 'atomic';

  return {
    archetype,
    triggerType,
    requiredIntegrations,
    missingCredentials,
    estimatedNodeCount,
    requiresPlanConfirmation: archetype === 'enterprise',
  };
}

// ── Enterprise Planner (ORCH §4.3 / §9) ──────────────────────────────────────

export interface PlanPhase {
  name: string;
  description: string;
  nodeKinds: string[];
  agentRole?: AgentRole;
  requiredCredential?: string;
  estimatedCostCents: [number, number];
  /** Per-phase model override (set when the operator edits a Phase Card). */
  model?: string;
}

export interface WorkflowPlan {
  archetype: WorkflowArchetype;
  phases: PlanPhase[];
  totalEstimatedCostCents: [number, number];
  missingDependencies: string[];
  requiresConfirmation: boolean;
  question?: string;
}

/**
 * Decompose a request into named phases (Phase Cards) before any node is built.
 * Deterministic HTN-lite: maps the classified signals to gather → analyze → draft
 * → deliver phases, casting the minimum-sufficient specialist per phase.
 */
export function planWorkflow(description: string, classification: IntentClassification): WorkflowPlan {
  const lower = description.toLowerCase();
  const phases: PlanPhase[] = [];
  const has = (re: RegExp) => re.test(lower);

  const fetches = has(/scrape|fetch|gather|collect|monitor|listen|source|feed|crawl|read (from|the)/);
  const analyzes = has(/analy|score|rank|classif|deduplicat|filter|extract|distil|map|assess|evaluate/);
  const drafts = has(/draft|write|summari|compose|generat|report|digest|post|content/);
  const delivers = classification.requiredIntegrations.length > 0 || has(/send|email|post|notify|alert|publish|deliver|queue|dashboard|calendar/);

  if (fetches) phases.push({ name: 'Gather Sources', description: 'Fetch + normalize the source material in parallel.', nodeKinds: ['parallel', 'http_request', 'merge'], agentRole: 'researcher', estimatedCostCents: [0, 1] });
  if (analyzes) phases.push({ name: 'Analyze & Score', description: 'Deduplicate, score, and filter to the items that matter.', nodeKinds: ['transform', 'agent_task'], agentRole: 'analyst', estimatedCostCents: [1, 3] });
  if (drafts) phases.push({ name: 'Draft Output', description: 'Produce the brand-aligned, formatted result.', nodeKinds: ['agent_task'], agentRole: 'writer', estimatedCostCents: [1, 3] });
  if (delivers) {
    const slug = classification.requiredIntegrations[0];
    phases.push({ name: 'Deliver', description: `Route the result to its destination${slug ? ` via ${slug}` : ''}.`, nodeKinds: ['checkpoint', 'integration'], requiredCredential: slug, estimatedCostCents: [0, 0] });
  }
  if (phases.length === 0) {
    phases.push({ name: 'Execute', description: 'Run the requested task and return a result.', nodeKinds: ['agent_task', 'return_output'], agentRole: 'writer', estimatedCostCents: [1, 3] });
  }

  const totalMin = phases.reduce((s, p) => s + p.estimatedCostCents[0], 0);
  const totalMax = phases.reduce((s, p) => s + p.estimatedCostCents[1], 0);
  return {
    archetype: classification.archetype,
    phases,
    totalEstimatedCostCents: [totalMin, totalMax],
    missingDependencies: classification.missingCredentials,
    requiresConfirmation: classification.requiresPlanConfirmation,
    question: classification.missingCredentials.length > 0
      ? `This plan needs ${classification.missingCredentials.join(', ')}. Configure the credential(s), or I'll add a pending-config integration node you can wire after.`
      : undefined,
  };
}

export interface CreationBrief {
  userRequest: string;
  callerName: string | null;
  callerRole: string | null;
  callerDomain: string;            // condensed instructions + keywords
  inventory: WorkspaceInventory;
  classification: IntentClassification;
}

/** Stages 1+4 — assemble the full brief, including the calling agent's domain identity. */
export async function assembleCreationBrief(deps: CreationDeps, workspaceId: string, agentId: string | null | undefined, description: string): Promise<CreationBrief> {
  const inventory = await buildWorkspaceInventory(deps, workspaceId, description);
  const classification = classifyIntent(description, inventory);

  let callerName: string | null = null;
  let callerRole: string | null = null;
  let callerDomain = '';
  if (agentId) {
    const agent = deps.db
      .select({ name: schema.agents.name, role: schema.agents.role, instructions: schema.agents.instructions })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
      .get();
    if (agent) {
      callerName = agent.name;
      callerRole = agent.role;
      // P7: domain authority belongs to the manager — only inject for non-orchestrators.
      if (agent.role !== 'orchestrator' && agent.instructions) {
        callerDomain = String(agent.instructions).slice(0, 800);
      }
    }
  }

  return { userRequest: description, callerName, callerRole, callerDomain, inventory, classification };
}

export interface PreflightWarning {
  code: 'CREDENTIAL_REQUIRED' | 'AGENT_UNBOUND' | 'AGENT_OFFLINE' | 'MISSING_OUTPUT' | 'DEAD_END' | 'BODY_REQUIRED' | 'CAPABILITY_MISMATCH';
  nodeId?: string;
  message: string;
}

/** Specialist fallback chains (§8): preferred role offline → next role with overlapping tools. */
export const SPECIALIST_FALLBACK: Partial<Record<AgentRole, AgentRole>> = {
  researcher: 'writer',
  analyst: 'coder',
  reviewer: 'architect',
  writer: 'researcher',
  coder: 'analyst',
  architect: 'reviewer',
  debugger: 'coder',
};

/** Infer the tools a node's task actually needs from its prompt/title (§8 casting). */
export function inferToolNeeds(text: string): AgentTool[] {
  const t = text.toLowerCase();
  const needs = new Set<AgentTool>();
  if (/\bhttp|url|fetch|scrape|website|web page|link\b/.test(t)) needs.add('read_url');
  if (/\bsearch the web|web search|google|look up online|research\b/.test(t)) needs.add('web_search');
  if (/\brun code|execute|compute|calculate|score|statistic|aggregate\b/.test(t)) needs.add('run_code');
  if (/\bread (the )?file|open file|load file\b/.test(t)) needs.add('read_file');
  if (/\bwrite (a |the )?file|save file|generate (a )?file|create (a )?(file|project)\b/.test(t)) needs.add('write_file');
  if (/\bdiff|review (the )?(pr|pull request|change)\b/.test(t)) needs.add('git_diff');
  if (/\bknowledge base|retrieve|recall|our docs|internal docs\b/.test(t)) needs.add('knowledge_search');
  return [...needs];
}

export interface TeamMember {
  role: AgentRole;
  tools: AgentTool[];
  status: 'online' | 'offline' | 'unknown';
  fallback?: AgentRole;
}

/** Build the team roster (§8) — the specialists this graph casts, with status + fallbacks. */
export function buildTeamRoster(graph: WorkflowGraph, inventory: WorkspaceInventory): TeamMember[] {
  const onlineRoles = new Set(inventory.availableAgents.filter((a) => a.status === 'online' && a.role).map((a) => a.role!));
  const roles = new Set<AgentRole>();
  for (const n of graph.nodes) {
    const c = n.config as { kind?: string; agentRole?: AgentRole };
    if ((c.kind === 'agent_task' || c.kind === 'agent_swarm') && c.agentRole) roles.add(c.agentRole);
  }
  return [...roles].map((role) => {
    const status: TeamMember['status'] = onlineRoles.has(role) ? 'online' : 'offline';
    const member: TeamMember = { role, tools: ROLE_TOOLS[role] ?? [], status };
    if (status !== 'online' && SPECIALIST_FALLBACK[role]) member.fallback = SPECIALIST_FALLBACK[role];
    return member;
  });
}

export interface PreflightResult {
  graph: WorkflowGraph;
  warnings: PreflightWarning[];
  estimatedCostCents: number;
}

/**
 * Stage 5 — operational validity, not just schema validity. Enriches the graph
 * (binds credentials from the inventory, guarantees a terminal output node) and
 * returns warnings the build narrates to the operator instead of failing on first run.
 */
export function preflightAndEnrich(graph: WorkflowGraph, inventory: WorkspaceInventory): PreflightResult {
  const warnings: PreflightWarning[] = [];
  const nodes = graph.nodes.map((n) => ({ ...n, config: { ...(n.config as unknown as Record<string, unknown>) } } as unknown as WorkflowNode));
  const credBySlug = new Map<string, string>();
  for (const c of inventory.configuredCredentials) if (!credBySlug.has(c.integrationSlug)) credBySlug.set(c.integrationSlug, c.id);
  const onlineAgent = new Map(inventory.availableAgents.map((a) => [a.id, a.status]));

  let estimatedCostCents = 0;
  for (const node of nodes) {
    const cfg = node.config as unknown as Record<string, unknown>;
    switch (cfg.kind) {
      case 'integration': {
        const slug = String(cfg.integrationId ?? '');
        if (!cfg.credentialId) {
          const credId = credBySlug.get(slug);
          if (credId) cfg.credentialId = credId; // CHECK 2 enrichment: bind from inventory
          else warnings.push({ code: 'CREDENTIAL_REQUIRED', nodeId: node.id, message: `${node.title}: no ${slug || 'integration'} credential configured — set one up to activate this step.` });
        }
        break;
      }
      case 'agent_task': {
        estimatedCostCents += 2; // rough per-agent-task estimate
        if (!cfg.agentId && !cfg.agentRole && (!Array.isArray(cfg.capabilityTags) || cfg.capabilityTags.length === 0)) {
          warnings.push({ code: 'AGENT_UNBOUND', nodeId: node.id, message: `${node.title}: no agent, role, or capability tags — assign one before running.` });
        } else if (cfg.agentId && onlineAgent.get(String(cfg.agentId)) && onlineAgent.get(String(cfg.agentId)) !== 'online') {
          warnings.push({ code: 'AGENT_OFFLINE', nodeId: node.id, message: `${node.title}: bound agent is offline — connect a runtime or it will fail on first run.` });
        }
        // §8 CAPABILITY_MISMATCH: the cast role must be able to do what the task needs.
        if (cfg.agentRole) {
          const role = cfg.agentRole as AgentRole;
          const manifest = ROLE_TOOLS[role] ?? [];
          const needs = inferToolNeeds(`${node.title} ${String(cfg.prompt ?? '')}`);
          const unmet = needs.filter((tool) => !manifest.includes(tool));
          if (needs.length > 0 && unmet.length === needs.length) {
            const better = (Object.keys(ROLE_TOOLS) as AgentRole[]).find((r) => needs.every((tool) => ROLE_TOOLS[r].includes(tool)));
            warnings.push({ code: 'CAPABILITY_MISMATCH', nodeId: node.id, message: `${node.title}: role '${role}' lacks ${unmet.join(', ')}${better ? ` — consider '${better}'` : ''}.` });
          }
        }
        break;
      }
      case 'agent_swarm':
        estimatedCostCents += 5;
        break;
      case 'loop':
        if (!cfg.bodyWorkflowId) warnings.push({ code: 'BODY_REQUIRED', nodeId: node.id, message: `${node.title}: loop has no body workflow.` });
        break;
      default:
        break;
    }
  }

  // CHECK / RULE 10 — guarantee a terminal output node.
  const hasOutput = nodes.some((n) => {
    const c = n.config as { kind?: string; isOutput?: boolean };
    return c.kind === 'return_output' || c.kind === 'artifact_save' || c.isOutput === true;
  });
  let edges = [...graph.edges];
  if (!hasOutput && nodes.length > 0) {
    const sources = new Set(edges.map((e) => e.source));
    const sinks = nodes.filter((n) => !sources.has(n.id));
    const last = sinks[sinks.length - 1] ?? nodes[nodes.length - 1]!;
    const outId = 'return_output';
    if (!nodes.some((n) => n.id === outId)) {
      nodes.push({ id: outId, type: 'return_output', title: 'Return Output', position: { x: last.position.x + 240, y: last.position.y }, config: { kind: 'return_output', renderAs: 'json' } });
      edges.push({ id: `edge_${last.id}_${outId}`, source: last.id, target: outId });
      warnings.push({ code: 'MISSING_OUTPUT', message: 'No output node found — added a Return Output so the run produces a result.' });
    }
  }

  // CHECK 4 — dead ends (advisory).
  const withOutgoing = new Set(edges.map((e) => e.source));
  for (const n of nodes) {
    const c = n.config as { kind?: string; isOutput?: boolean };
    const terminal = c.kind === 'return_output' || c.kind === 'artifact_save' || c.isOutput === true;
    if (!terminal && !withOutgoing.has(n.id) && nodes.length > 1) {
      warnings.push({ code: 'DEAD_END', nodeId: n.id, message: `${n.title}: no outgoing edge — its output is never used.` });
    }
  }

  return { graph: { ...graph, nodes, edges }, warnings, estimatedCostCents };
}

/** credentialType / name → connector slug. */
function inferSlug(credentialType: string, name: string): string {
  const hay = `${credentialType} ${name}`.toLowerCase();
  for (const slug of CONNECTOR_SLUGS) if (hay.includes(slug)) return slug;
  if (/mail/.test(hay)) return 'gmail';
  return credentialType.toLowerCase();
}
