/**
 * AgentToolRuntime - role-scoped tool execution.
 *
 * Executes the capabilities granted to a specialist role. Workspace memory
 * writes go to the canonical DB brain, not to workspace Markdown files.
 */

import { AgentisError, roleTools, type AgentRole, type AgentTool } from '@agentis/core';
import { evaluateExpression } from '../engine/safeExpression.js';
import { assertSafeUrl } from './safeUrl.js';
import type { WorkspaceVolumeService } from './workspaceVolume.js';
import type { KnowledgeBaseService } from './knowledgeBase.js';
import type { WorkflowStoreService } from './workflowStore.js';
import type { AgentMemoryService } from './agentMemory.js';
import type { MemoryStore } from './memoryStore.js';
import type { Logger } from '../logger.js';

export interface AgentToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Run-scoped context for a tool call beyond the workspace it belongs to. */
export interface AgentToolContext {
  /** The workflow this agent is running inside, when dispatched from a graph. */
  workflowId?: string;
  /** The concrete agent executing the tool; scopes agent-private memory. */
  agentId?: string;
  /**
   * Explicit granted manifest. When set, a tool is permitted if it's in this set
   * OR the role's static manifest — so a custom/generated specialist with the
   * default toolbox can act without a hardcoded role entry, while platform roles
   * keep their manifest. The caller (the tool loop) is responsible for only
   * granting tools it actually offered the model.
   */
  grantedTools?: AgentTool[];
}

export interface AgentToolRuntimeDeps {
  volume: WorkspaceVolumeService;
  knowledgeBases?: KnowledgeBaseService;
  /** Canonical DB brain memory; backs workspace-scoped `memory_append`. */
  memory?: MemoryStore;
  /** Per-workflow persistent KV; backs `workflow_memory_read` / `workflow_memory_write`. */
  workflowStore?: WorkflowStoreService;
  /** Per-agent personal memory; backs `agent_memory_search` and agent-scoped `memory_append`. */
  agentMemory?: AgentMemoryService;
  logger?: Logger;
  /** Same-workspace workflow invocation. Injected to avoid an engine import here. */
  callWorkflow?: (args: { workspaceId: string; workflowId: string; inputs: Record<string, unknown> }) => Promise<unknown>;
  /** Optional web-search provider. When absent, `web_search` reports unavailable. */
  webSearch?: (query: string) => Promise<unknown>;
}

const SECRET_RE = /(^|\/)\.env(\.|$)|(^|\/)\.git\//i;

export class AgentToolRuntime {
  constructor(private readonly deps: AgentToolRuntimeDeps) {}

  /** The tools a role is permitted to call. */
  toolsForRole(role: AgentRole): AgentTool[] {
    return roleTools(role);
  }

  /** True when the role's manifest grants the tool. */
  roleHasTool(role: AgentRole, tool: AgentTool): boolean {
    return this.toolsForRole(role).includes(tool);
  }

  /**
   * Execute a tool. When `role` is provided, the call is rejected unless the
   * role manifest grants it. `context.workflowId` scopes workflow-memory tools.
   */
  async execute(
    workspaceId: string,
    tool: AgentTool,
    args: Record<string, unknown>,
    role?: AgentRole,
    context: AgentToolContext = {},
  ): Promise<AgentToolResult> {
    const grantedByContext = context.grantedTools?.includes(tool) ?? false;
    if (role && !this.roleHasTool(role, tool) && !grantedByContext) {
      return { ok: false, error: `role '${role}' is not granted tool '${tool}'` };
    }
    try {
      const result = await this.#run(workspaceId, tool, args, context);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof AgentisError ? err.message : (err as Error).message;
      this.deps.logger?.warn('agent_tool.failed', { workspaceId, tool, error: message });
      return { ok: false, error: message };
    }
  }

  async #run(workspaceId: string, tool: AgentTool, args: Record<string, unknown>, context: AgentToolContext): Promise<unknown> {
    switch (tool) {
      case 'read_file': {
        const path = requireStr(args.path, 'path');
        assertNotSecret(path);
        const content = await this.deps.volume.read(workspaceId, path);
        if (content == null) throw new AgentisError('RESOURCE_NOT_FOUND', `file not found: ${path}`);
        return { path, content };
      }
      case 'write_file': {
        const path = requireStr(args.path, 'path');
        assertNotSecret(path);
        const content = typeof args.content === 'string' ? args.content : JSON.stringify(args.content ?? '', null, 2);
        const entry = await this.deps.volume.write(workspaceId, path, content);
        return { path: entry.path, size: entry.size };
      }
      case 'search_code': {
        const query = requireStr(args.query, 'query');
        return { matches: await this.#searchCode(workspaceId, query, typeof args.dir === 'string' ? args.dir : '') };
      }
      case 'run_code': {
        const expression = requireStr(args.expression ?? args.code, 'expression');
        const value = evaluateExpression<unknown>(expression, { input: args.input ?? {}, ctx: {} });
        return { value };
      }
      case 'knowledge_search': {
        if (!this.deps.knowledgeBases) throw new AgentisError('VALIDATION_FAILED', 'knowledge base service not available');
        const query = requireStr(args.query, 'query');
        const topK = typeof args.topK === 'number' ? args.topK : 5;
        const bases = this.deps.knowledgeBases.listKnowledgeBases(workspaceId);
        const hits = (await Promise.all(bases.map((b) =>
          this.deps.knowledgeBases!.search({ workspaceId, knowledgeBaseId: b.id, query, topK }))))
          .flat()
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        return { query, results: hits };
      }
      case 'memory_append': {
        const section = requireStr(args.section, 'section');
        const entry = requireStr(args.entry, 'entry');
        const scope = args.scope === 'agent' ? 'agent' : 'workspace';
        // Memory is for durable statements, not questions or throwaway notes.
        // Without this, a model can store the operator's question verbatim
        // ("how do I like responses?") as if it were a learned preference.
        const lowValue = lowValueMemoryReason(entry);
        if (lowValue) {
          return { ok: false, scope, section, skipped: true, reason: lowValue };
        }
        if (scope === 'agent') {
          if (!this.deps.agentMemory) throw new AgentisError('VALIDATION_FAILED', 'agent memory service not available');
          if (!context.agentId) throw new AgentisError('VALIDATION_FAILED', 'agent-scoped memory requires an agent identity');
          this.deps.agentMemory.append({ agentId: context.agentId, workspaceId, section, content: entry });
          return { ok: true, scope, section };
        }
        if (!this.deps.memory) throw new AgentisError('VALIDATION_FAILED', 'workspace memory service not available');
        const memoryId = this.deps.memory.write({
          workspaceId,
          scopeId: null,
          kind: kindFromSection(section),
          source: 'agent',
          title: titleFromSection(section, entry),
          content: entry,
          trust: 0.72,
          importance: 0.62,
          tags: ['agent_tool', 'memory_append', normalizeTag(section), ...(context.agentId ? ['agent'] : [])],
          provenance: {
            source: 'agent_tool_memory_append',
            section,
            workflowId: context.workflowId ?? null,
            agentId: context.agentId ?? null,
          },
        });
        return { ok: true, scope, section, memoryId };
      }
      case 'agent_memory_search': {
        if (!this.deps.agentMemory) throw new AgentisError('VALIDATION_FAILED', 'agent memory service not available');
        if (!context.agentId) throw new AgentisError('VALIDATION_FAILED', 'agent memory requires an agent identity');
        const query = requireStr(args.query, 'query');
        const topK = typeof args.topK === 'number' ? args.topK : 5;
        return { query, results: this.deps.agentMemory.search(context.agentId, workspaceId, query, topK) };
      }
      case 'workflow_memory_read': {
        if (!this.deps.workflowStore) throw new AgentisError('VALIDATION_FAILED', 'workflow memory service not available');
        if (!context.workflowId) throw new AgentisError('VALIDATION_FAILED', 'workflow memory is only available inside a workflow run');
        if (args.key == null || args.key === '') {
          return { workflowId: context.workflowId, snapshot: this.deps.workflowStore.snapshot(workspaceId, context.workflowId) };
        }
        const key = requireStr(args.key, 'key');
        return { workflowId: context.workflowId, key, value: this.deps.workflowStore.get(workspaceId, context.workflowId, key) };
      }
      case 'workflow_memory_write': {
        if (!this.deps.workflowStore) throw new AgentisError('VALIDATION_FAILED', 'workflow memory service not available');
        if (!context.workflowId) throw new AgentisError('VALIDATION_FAILED', 'workflow memory is only available inside a workflow run');
        const key = requireStr(args.key, 'key');
        const value = this.deps.workflowStore.set(workspaceId, context.workflowId, key, args.value ?? null);
        return { workflowId: context.workflowId, key, value };
      }
      case 'read_url': {
        const url = requireStr(args.url, 'url');
        const parsed = await assertSafeUrl(url, { allowPrivate: false });
        const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(20_000) });
        const html = await res.text();
        return { url: parsed.toString(), status: res.status, text: stripHtml(html).slice(0, 20_000) };
      }
      case 'call_workflow': {
        if (!this.deps.callWorkflow) throw new AgentisError('VALIDATION_FAILED', 'call_workflow is not wired in this runtime');
        const workflowId = requireStr(args.workflowId, 'workflowId');
        const inputs = args.inputs && typeof args.inputs === 'object' ? args.inputs as Record<string, unknown> : {};
        return await this.deps.callWorkflow({ workspaceId, workflowId, inputs });
      }
      case 'web_search': {
        if (!this.deps.webSearch) throw new AgentisError('VALIDATION_FAILED', 'web_search provider is not configured');
        return await this.deps.webSearch(requireStr(args.query, 'query'));
      }
      case 'git_diff':
      case 'git_status':
        throw new AgentisError('VALIDATION_FAILED', `${tool} requires a git-backed workspace (not available for Volume-only workspaces)`);
      default:
        throw new AgentisError('VALIDATION_FAILED', `unknown tool: ${String(tool)}`);
    }
  }

  /** Naive text search across Volume files. */
  async #searchCode(workspaceId: string, query: string, dir: string): Promise<Array<{ path: string; line: number; text: string }>> {
    const out: Array<{ path: string; line: number; text: string }> = [];
    const needle = query.toLowerCase();
    const visit = async (rel: string, depth: number): Promise<void> => {
      if (depth > 4 || out.length >= 100) return;
      const entries = await this.deps.volume.list(workspaceId, rel);
      for (const e of entries) {
        if (out.length >= 100) break;
        if (e.kind === 'dir') {
          await visit(e.path, depth + 1);
          continue;
        }
        if ((e.size ?? 0) > 512_000) continue;
        const content = await this.deps.volume.read(workspaceId, e.path);
        if (content == null) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]!.toLowerCase().includes(needle)) {
            out.push({ path: e.path, line: i + 1, text: lines[i]!.slice(0, 200) });
            if (out.length >= 100) break;
          }
        }
      }
    };
    await visit(dir, 0);
    return out;
  }
}

function requireStr(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentisError('VALIDATION_FAILED', `tool argument '${name}' must be a non-empty string`);
  }
  return value;
}

function assertNotSecret(path: string): void {
  if (SECRET_RE.test(path)) {
    throw new AgentisError('WORKSPACE_VOLUME_PATH_ESCAPE', `access to '${path}' is blocked (secrets/VCS)`);
  }
}

function kindFromSection(section: string): 'fact' | 'preference' | 'pattern' | 'rule' | 'lesson' {
  const s = section.toLowerCase();
  // `\w*` suffixes so plurals/inflections match ("rules", "preference",
  // "patterns"). The previous `\bpref\b` never matched "preference".
  if (/\b(rule|policy|decision|constraint|must|never|always)\w*/.test(s)) return 'rule';
  if (/\b(pref|style|tone|default)\w*/.test(s)) return 'preference';
  if (/\b(pattern|effective|repeat|work)\w*/.test(s)) return 'pattern';
  if (/\b(fail|lesson|correction|avoid|mistake)\w*/.test(s)) return 'lesson';
  return 'fact';
}

/**
 * Reject memory writes that aren't durable statements. Returns a human reason
 * when the entry should be skipped, or null when it's worth storing. Mirrors
 * the chat-capture guard so both write paths stay consistent.
 */
function lowValueMemoryReason(entry: string): string | null {
  const text = entry.trim();
  if (text.length < 8) return 'entry too short to be a durable memory';
  // A question ("how do I like responses?") is never a memory. Imperatives
  // that open with "do not"/"don't" are rules, not questions.
  if (/\?\s*$/.test(text) && !/^(do not|don'?t)\b/i.test(text)) return 'questions are not memories';
  return null;
}

function titleFromSection(section: string, entry: string): string {
  const label = section.trim() || 'Agent memory';
  const body = entry.replace(/\s+/g, ' ').trim();
  const clipped = body.length > 80 ? `${body.slice(0, 77).trim()}...` : body;
  return `${label}: ${clipped}`;
}

function normalizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'memory';
}

/** Strip tags + collapse whitespace for read_url text extraction. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
