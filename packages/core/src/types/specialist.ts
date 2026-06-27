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

export const LEGACY_PLATFORM_ROLES: readonly PlatformRole[] = [
  'planner', 'researcher', 'coder', 'reviewer', 'analyst',
  'writer', 'monitor', 'architect', 'debugger', 'deployer',
] as const;

/**
 * Built-in platform specialists are no longer shipped. Keep this empty export
 * so older imports compile without reintroducing seed/routing data.
 */
export const PLATFORM_ROLES: readonly PlatformRole[] = [];

/** @deprecated Built-in platform specialist roles are no longer shipped. */
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

export function isSpecialistRole(role: string | null | undefined): boolean {
  const normalized = normalizeRole(role ?? '').toLowerCase();
  return normalized !== 'orchestrator' && normalized !== 'manager';
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
  // ── Browser/computer-use: drive headless Chromium during the reasoning loop ──
  | 'browser_screenshot'
  | 'browser_navigate'
  | 'browser_extract_text'
  | 'browser_extract_table'
  | 'browser_fill_form'
  | 'knowledge_search'
  | 'memory_append'
  | 'agent_memory_search'
  | 'workflow_memory_read'
  | 'workflow_memory_write'
  | 'call_workflow'
  // ── AG-UI: author Agentic App surfaces (AGENTIC-APPS-10X-MASTERPLAN §4) ──
  | 'ui_render'
  | 'ui_patch'
  | 'ui_action_schema'
  // ── App Datastore: typed collections + records (§5) ──
  | 'data_define_collection'
  | 'data_insert'
  | 'data_update'
  | 'data_upsert'
  | 'data_delete'
  | 'data_query'
  /** Brain bridge (§5.4) — promote a datastore record into workspace memory. */
  | 'data_promote_memory';

export const ROLE_TOOLS: Partial<Record<PlatformRole, AgentTool[]>> = {};

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
  'browser_screenshot',
  'browser_navigate',
  'browser_extract_text',
  'browser_extract_table',
  'browser_fill_form',
  'ui_render',
  'ui_patch',
  'ui_action_schema',
  'data_define_collection',
  'data_insert',
  'data_update',
  'data_upsert',
  'data_delete',
  'data_query',
  'data_promote_memory',
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
  browser_screenshot: 'Open a real (headless) browser, render a URL or inline HTML, and capture a PNG screenshot saved as an artifact. Chat renders the artifact automatically; to send it through a channel, pass `ref` to agentis.channel.send attachments. Returns { artifactId, ref, url }. args: { url?: string, html?: string, fullPage?: boolean, viewport?: { width, height }, title?: string }',
  browser_navigate: 'Open a real browser, load a URL, and return its { title, text, html }. Use to read JS-rendered pages that read_url cannot. args: { url: string }',
  browser_extract_text: 'Open a real browser, load a URL (or html), and return the visible text under a CSS selector (default body). args: { url?: string, html?: string, selector?: string }',
  browser_extract_table: 'Open a real browser and parse an HTML <table> into an array of row objects. args: { url?: string, html?: string, selector?: string }',
  browser_fill_form: 'Open a real browser, fill form fields by CSS selector, optionally submit, and return the read-back values + final HTML. args: { url?: string, html?: string, formData: { [selector]: value }, submitSelector?: string }',
  knowledge_search: 'Search the workspace Brain (knowledge bases) for relevant passages. args: { query: string, topK?: number }',
  memory_append: 'Record a finding or decision so future runs start knowing it. scope "workspace" (default) writes the shared log every agent sees; scope "agent" writes your own private memory. args: { section: string, entry: string, scope?: "workspace" | "agent" }',
  agent_memory_search: 'Recall your own past findings from your personal memory (separate from the shared workspace log). args: { query: string, topK?: number }',
  workflow_memory_read: 'Read persistent state this workflow saved on a prior run (cursors, dedup keys, accumulated findings). args: { key?: string }',
  workflow_memory_write: 'Persist state for future runs of this workflow. args: { key: string, value: unknown }',
  call_workflow: 'Invoke another workflow in this workspace. args: { workflowId: string, inputs?: object }',
  ui_render: 'Author the full UI of an Agentic App surface as a typed ViewNode tree. AGENT-NATIVE composites (prefer these — they make the surface a living agentic app, not a static dashboard): AgentConsole (the operator agent presence + a command line the human uses to direct you), ActivityStream (a live feed of your work), DataBoard ({ bind, groupBy, titleField? } — a kanban over a collection grouped by a status field). Plus data/content nodes: Stack/Row/Grid/Card/Text/Heading/Metric/Table/List/Form/Button/Chart/Badge. Tables/Lists/Charts/Boards bind to a collection ({ bind: { collection, query?, sort?, limit? } }); Buttons/Forms declare an action ({ action: "name", args }) registered with ui_action_schema. Lead operator-facing surfaces with an AgentConsole + ActivityStream. Replaces the surface view. args: { surface: string, view: ViewNode }',
  ui_patch: 'Mutate part of an existing surface view without re-sending the whole tree. args: { surface: string, ops: Array<{ op: "set"|"insert"|"remove", path, value?|node? }> }',
  ui_action_schema: 'Declare the actions a surface\'s buttons/forms can invoke. Each action resolves to a workflow run, an agent tool, or a datastore op. args: { surface: string, actions: Array<{ name, kind: "workflow"|"tool"|"data", target, inputSchema? }> }',
  data_define_collection: 'Define (or update) a typed App Datastore collection. Fields: { key, type: "string"|"number"|"boolean"|"date"|"json", required?, indexed? }. args: { name: string, schema: { fields: [...] } }',
  data_insert: 'Insert a record into a collection. Validated against the collection schema. args: { collection: string, record: object }',
  data_update: 'Patch a record by id. args: { collection: string, id: string, patch: object }',
  data_upsert: 'Insert, or update the first record matching `match`. args: { collection: string, match: object, record: object }',
  data_delete: 'Delete a record by id. args: { collection: string, id: string }',
  data_query: 'Query records. Filter ops: eq/ne/gt/gte/lt/lte/contains/in, or a bare value for equality. args: { collection: string, filter?: object, sort?: [{field,dir}], limit?: number, cursor?: string }',
  data_promote_memory: 'Promote a datastore record into the workspace Brain as a durable memory (one-way bridge — data stays the source of truth). Use for facts worth remembering across runs (a customer preference, a decision). args: { collection: string, id: string, title?: string }',
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

export const SPECIALIST_AGENTS: readonly SpecialistDefinition[] = [];

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
