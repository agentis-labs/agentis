/**
 * Specialist agent library + role-scoped tool manifests.
 * WORKFLOW-10X-MASTERPLAN Layer 2 (Â§2.1â€“2.2).
 *
 * These are workspace-portable definitions: the engine resolves an
 * `agent_task.agentRole` to the workspace's actual agent carrying that role at
 * run time. Each role ships a system prompt, capability tags, default model, and
 * a tool manifest (the capabilities the agentic loop grants at dispatch).
 */

/**
 * The 10 platform specialist roles ship as seed templates. They keep strong
 * literal typing so the role→tools / role→definition maps stay exhaustive.
 */
export type PlatformRole =
  | 'planner'
  | 'researcher'
  | 'coder'
  | 'reviewer'
  | 'analyst'
  | 'writer'
  | 'monitor'
  | 'architect'
  | 'debugger'
  | 'deployer';

/**
 * A role is now an open vocabulary: any non-empty string is a legal specialist
 * functional role (e.g. `frontend_architect`, `tax_analyst`). The `(string & {})`
 * member keeps editor autocomplete for the platform roles while accepting custom
 * ones. Built-ins resolve to rich definitions; custom roles resolve through the
 * workspace agent library or a synthesized generic definition (see
 * `genericSpecialist`). `worker` is legacy and normalizes to a specialist.
 */
export type AgentRole = PlatformRole | (string & {});

export const PLATFORM_ROLES: readonly PlatformRole[] = [
  'planner', 'researcher', 'coder', 'reviewer', 'analyst',
  'writer', 'monitor', 'architect', 'debugger', 'deployer',
] as const;

/** @deprecated Use `PLATFORM_ROLES`. Retained for backwards compatibility. */
export const AGENT_ROLES = PLATFORM_ROLES;

/** Strict membership in the 10 built-in platform roles. */
export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

/**
 * A usable role string. Roles are an open vocabulary, so this only rejects
 * empty/non-string values. Use `isPlatformRole` when you need a built-in.
 * `worker` is accepted but should be normalized to `specialist` semantics.
 */
export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Normalize legacy `worker` terminology to the generic `specialist` role. */
export function normalizeRole(role: string): string {
  const r = role.trim();
  return r === 'worker' ? 'specialist' : r;
}

/**
 * Capabilities the engine grants a role at dispatch time (the agentic tool-use loop).
 *
 * The Brain tools â€” `knowledge_search`, `memory_append`, `workflow_memory_read`,
 * `workflow_memory_write` â€” let an agent read from and write back to the
 * workspace Brain (knowledge bases, DB-backed memory atoms, and per-workflow
 * persistent state) during its own reasoning loop, not just via graph nodes.
 */
export type AgentTool =
  | 'web_search'
  | 'read_url'
  | 'read_file'
  | 'write_file'
  | 'search_code'
  | 'run_code'
  | 'git_diff'
  | 'git_status'
  | 'knowledge_search'
  | 'memory_append'
  | 'agent_memory_search'
  | 'workflow_memory_read'
  | 'workflow_memory_write'
  | 'call_workflow';

export const ROLE_TOOLS: Record<PlatformRole, AgentTool[]> = {
  planner: ['knowledge_search', 'memory_append', 'agent_memory_search', 'workflow_memory_read', 'workflow_memory_write', 'call_workflow'],
  researcher: ['web_search', 'read_url', 'knowledge_search', 'memory_append', 'agent_memory_search'],
  coder: ['read_file', 'write_file', 'run_code', 'search_code', 'git_status'],
  reviewer: ['read_file', 'git_diff', 'search_code', 'run_code'],
  analyst: ['read_file', 'run_code', 'knowledge_search', 'memory_append', 'agent_memory_search', 'workflow_memory_read', 'workflow_memory_write'],
  writer: ['web_search', 'read_url', 'read_file'],
  monitor: ['read_url', 'knowledge_search', 'memory_append', 'agent_memory_search', 'workflow_memory_read', 'workflow_memory_write', 'call_workflow'],
  architect: ['read_file', 'search_code', 'knowledge_search', 'git_diff'],
  debugger: ['read_file', 'run_code', 'search_code', 'git_diff', 'git_status'],
  deployer: ['read_file', 'call_workflow'],
};

/**
 * The default capability set granted to ANY specialist whose role has no explicit
 * platform tool manifest (custom/generated roles like `frontend_architect` or
 * `tax_analyst`). Without this, a custom specialist would get an empty toolbox and
 * collapse to a single-shot text generator. This is the "knowledge worker" floor:
 * research (web/url), the workspace Brain (knowledge + memory), durable workflow
 * state, sandboxed compute, and workflow composition. Coding-style platform roles
 * keep their richer file/git manifests via ROLE_TOOLS.
 */
export const DEFAULT_SPECIALIST_TOOLS: AgentTool[] = [
  'web_search',
  'read_url',
  'knowledge_search',
  'agent_memory_search',
  'memory_append',
  'workflow_memory_read',
  'workflow_memory_write',
  'run_code',
  'call_workflow',
];

/** Role-scoped tool manifest, safe for the open role vocabulary (unknown → none). */
export function roleTools(role: AgentRole): AgentTool[] {
  return (ROLE_TOOLS as Record<string, AgentTool[]>)[role] ?? [];
}

/**
 * The tools a specialist actually gets at dispatch: its explicit manifest, or the
 * universal default set when it has none. This is what makes every specialist an
 * agent (tool-using) rather than a single completion.
 */
export function effectiveSpecialistTools(def: { tools?: AgentTool[]; role: AgentRole }): AgentTool[] {
  if (def.tools && def.tools.length > 0) return def.tools;
  const fromRole = roleTools(def.role);
  return fromRole.length > 0 ? fromRole : DEFAULT_SPECIALIST_TOOLS;
}

/** One-line tool descriptions offered to the agentic tool-use loop. */
export const TOOL_DESCRIPTIONS: Record<AgentTool, string> = {
  web_search: 'Search the web for recent information. args: { query: string }',
  read_url: 'Fetch a URL and return its extracted text. args: { url: string }',
  read_file: 'Read a file from the workspace volume. args: { path: string }',
  write_file: 'Create or overwrite a workspace file. args: { path: string, content: string }',
  search_code: 'Find text across workspace files. args: { query: string, dir?: string }',
  run_code: 'Evaluate a sandboxed JS expression â€” no I/O, pure compute. args: { expression: string, input?: object }',
  git_diff: 'Show the working-tree diff (git-backed workspaces only).',
  git_status: 'Show git status (git-backed workspaces only).',
  knowledge_search: 'Search the workspace Brain (knowledge bases) for relevant passages. args: { query: string, topK?: number }',
  memory_append: 'Record a finding or decision so future runs start knowing it. scope "workspace" (default) writes the shared log every agent sees; scope "agent" writes your own private memory. args: { section: string, entry: string, scope?: "workspace" | "agent" }',
  agent_memory_search: 'Recall your own past findings from your personal memory (separate from the shared workspace log). args: { query: string, topK?: number }',
  workflow_memory_read: 'Read persistent state this workflow saved on a prior run (cursors, dedup keys, accumulated findings). args: { key?: string }',
  workflow_memory_write: 'Persist state for future runs of this workflow. args: { key: string, value: unknown }',
  call_workflow: 'Invoke another workflow in this workspace. args: { workflowId: string, inputs?: object }',
};

export interface SpecialistDefinition {
  role: AgentRole;
  /** Where this definition came from. Built-ins are `platform`. */
  source?: 'platform' | 'custom' | 'community' | 'generated';
  name: string;
  description: string;
  /** Prepended to every dispatch for an agent of this role. */
  systemPrompt: string;
  capabilityTags: string[];
  /** Model hint stored in agent config; the runtime maps it to a concrete model. */
  defaultModel: string;
  tools: AgentTool[];
  avatarGlyph: string;
  colorHex: string;
}

const def = (
  role: PlatformRole,
  name: string,
  description: string,
  systemPrompt: string,
  capabilityTags: string[],
  defaultModel: string,
  avatarGlyph: string,
  colorHex: string,
): SpecialistDefinition => ({ role, source: 'platform', name, description, systemPrompt, capabilityTags, defaultModel, tools: ROLE_TOOLS[role], avatarGlyph, colorHex });

export const SPECIALIST_AGENTS: readonly SpecialistDefinition[] = [
  def('planner', 'Planner',
    'Goal decomposition, HTN planning, workflow building, re-planning',
    'You are the Planner. Decompose the goal into the smallest set of phases with clear success criteria. Read workspace context first. Prefer delegating to specialists and composing existing workflows over doing everything yourself. Output structured, actionable plans â€” never a wall of prose.',
    ['planning', 'orchestration'], 'gpt-4o', 'â—†', '#8b5cf6'),
  def('researcher', 'Researcher',
    'Web search, document analysis, synthesis, knowledge extraction',
    'You are the Researcher. Gather facts from the web, URLs, and the knowledge base. Cite sources. Synthesize concisely and flag uncertainty â€” never fabricate.',
    ['research', 'web'], 'gpt-4o-mini', 'â—Ž', '#0ea5e9'),
  def('coder', 'Code Writer',
    'TDD, implementation, refactoring, test writing',
    'You are the Code Writer. Follow the workspace stack and conventions exactly. Write tests first when practical. Make the smallest correct change; no speculative abstractions.',
    ['code', 'implementation'], 'claude-sonnet', 'âŒ¨', '#22c55e'),
  def('reviewer', 'Reviewer',
    'Security scan, code quality, architecture review, PR review',
    'You are the Reviewer. Check for security issues (OWASP Top 10), correctness, and convention violations. Separate blocking from non-blocking findings. Be specific with file/line references.',
    ['review', 'security'], 'gpt-4o', 'âš–', '#f59e0b'),
  def('analyst', 'Data Analyst',
    'Data transformation, statistical analysis, pattern detection, reporting',
    'You are the Data Analyst. Transform and analyze data rigorously. Show the method behind every number. Prefer tables and clear summaries.',
    ['analysis', 'data'], 'gpt-4o-mini', 'â–¤', '#06b6d4'),
  def('writer', 'Content Writer',
    'Blog posts, summaries, reports, emails, documentation',
    'You are the Content Writer. Write clear, audience-appropriate prose. Match the requested format and length. Lead with what matters.',
    ['writing', 'content'], 'claude-sonnet', 'âœŽ', '#ec4899'),
  def('monitor', 'Monitor',
    'Metric tracking, anomaly detection, alerting, health reporting',
    'You are the Monitor. Track metrics, detect anomalies against expected ranges, and report health crisply. Escalate only real signal.',
    ['monitoring', 'alerting'], 'gpt-4o-mini', 'â—‰', '#ef4444'),
  def('architect', 'Architect',
    'System design, ADR writing, technology evaluation',
    'You are the Architect. Propose designs that fit existing architectural decisions (read DECISIONS.md). Record trade-offs as ADRs. Flag anything that contradicts prior decisions.',
    ['architecture', 'design'], 'gpt-4o', 'âŒ—', '#a855f7'),
  def('debugger', 'Debugger',
    'Root-cause analysis, structured diagnosis, fix verification',
    'You are the Debugger. Reproduce, isolate, and explain the root cause before proposing a fix. Verify the fix addresses the cause, not the symptom.',
    ['debugging', 'diagnosis'], 'claude-sonnet', 'â˜£', '#f97316'),
  def('deployer', 'Deployer',
    'CI/CD orchestration, environment management, rollback',
    'You are the Deployer. Follow safe-deploy rules from workspace constraints (e.g. no Friday prod deploys). Always have a rollback plan. Verify health after each step.',
    ['deployment', 'ops'], 'gpt-4o-mini', 'â¬¢', '#14b8a6'),
];

/** Resolve a built-in platform specialist, throwing if the role is unknown. */
export function specialistForRole(role: AgentRole): SpecialistDefinition;
/** Resolve a built-in specialist, returning `fallback` instead of throwing for unknown roles. */
export function specialistForRole(role: AgentRole, fallback: SpecialistDefinition | null): SpecialistDefinition | null;
export function specialistForRole(
  role: AgentRole,
  fallback?: SpecialistDefinition | null,
): SpecialistDefinition | null {
  const found = SPECIALIST_AGENTS.find((s) => s.role === role);
  if (found) return found;
  if (arguments.length >= 2) return fallback ?? null;
  throw new Error(`Unknown agent role: ${role}`);
}

/** Title-case a role slug for display, e.g. `frontend_architect` → `Frontend Architect`. */
function humanizeRole(role: string): string {
  return role
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Specialist';
}

/**
 * Synthesize a neutral specialist definition for a custom role with no built-in
 * or library entry. This keeps the engine non-blocking: an unknown role still
 * gets a sane identity prompt and an empty (read-only) tool manifest rather than
 * throwing. Callers that have a richer library definition should prefer it.
 */
export function genericSpecialist(
  role: AgentRole,
  overrides: Partial<Omit<SpecialistDefinition, 'role'>> = {},
): SpecialistDefinition {
  const name = overrides.name ?? humanizeRole(role);
  return {
    role,
    source: overrides.source ?? 'generated',
    name,
    description: overrides.description ?? `On-demand specialist for ${name}.`,
    systemPrompt:
      overrides.systemPrompt ??
      `You are the ${name}, a specialist. Apply deep, focused expertise to the task within your domain. ` +
        `Read the workspace context and mission brief first. State assumptions, cite sources for factual claims, ` +
        `flag anything outside your competence, and prefer concise, structured, actionable output over prose.`,
    capabilityTags: overrides.capabilityTags ?? [role],
    defaultModel: overrides.defaultModel ?? 'gpt-4o',
    // A generated specialist is still an AGENT: give it the universal toolbox when
    // its role carries no explicit manifest, so it can research, recall, compute,
    // and persist — not just emit one block of text.
    tools: overrides.tools ?? (roleTools(role).length > 0 ? roleTools(role) : DEFAULT_SPECIALIST_TOOLS),
    avatarGlyph: overrides.avatarGlyph ?? '✦',
    colorHex: overrides.colorHex ?? '#6366f1',
  };
}
