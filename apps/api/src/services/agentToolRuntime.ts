/**
 * AgentToolRuntime — role-scoped tool execution (WORKFLOW-10X-MASTERPLAN §2.2.1).
 *
 * Executes the capabilities granted to a specialist role (ROLE_TOOLS): file I/O
 * scoped to the Workspace Volume, sandboxed code evaluation, code search,
 * knowledge retrieval, and safe URL fetch. This is the substance of the agentic
 * tool-use loop; the LLM function-calling loop that *drives* these handlers is
 * provided by the orchestrator runtime (out of scope here).
 *
 * Security boundaries (enforced here, in one place):
 *  - `read_file` / `write_file` are scoped to the workspace Volume (path-escape
 *    guarded) and reject `.env` / dotenv-style secrets.
 *  - `run_code` uses the same sandboxed evaluator as the Transform node — no I/O,
 *    no `require`, no `process`, no `fetch`.
 *  - `read_url` passes through the SSRF guard (`assertSafeUrl`).
 *  - `call_workflow` only invokes workflows in the same workspace (delegated to an
 *    injected callback so the engine dependency stays out of this module).
 */

import { AgentisError, ROLE_TOOLS, type AgentRole, type AgentTool } from '@agentis/core';
import { evaluateExpression } from '../engine/safeExpression.js';
import { assertSafeUrl } from './safeUrl.js';
import type { WorkspaceVolumeService } from './workspaceVolume.js';
import type { KnowledgeBaseService } from './knowledgeBase.js';
import type { WorkspaceIntelligenceService } from './workspaceIntelligence.js';
import type { WorkflowStoreService } from './workflowStore.js';
import type { AgentMemoryService } from './agentMemory.js';
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
  /** The concrete agent executing the tool — scopes the agent's personal memory. */
  agentId?: string;
}

export interface AgentToolRuntimeDeps {
  volume: WorkspaceVolumeService;
  knowledgeBases?: KnowledgeBaseService;
  /** Brain memory log — backs the workspace scope of `memory_append`. */
  workspaceIntelligence?: WorkspaceIntelligenceService;
  /** Per-workflow persistent KV — backs `workflow_memory_read` / `workflow_memory_write`. */
  workflowStore?: WorkflowStoreService;
  /** Per-agent personal memory — backs `agent_memory_search` + the agent scope of `memory_append`. */
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
    return ROLE_TOOLS[role] ?? [];
  }

  /** True when the role's manifest grants the tool. */
  roleHasTool(role: AgentRole, tool: AgentTool): boolean {
    return this.toolsForRole(role).includes(tool);
  }

  /**
   * Execute a tool. When `role` is provided, the call is rejected unless the
   * role's manifest grants the tool (defense in depth alongside the LLM only
   * being offered its allowed tools). `context.workflowId` scopes the Brain's
   * workflow-memory tools to the workflow the agent is running inside.
   */
  async execute(
    workspaceId: string,
    tool: AgentTool,
    args: Record<string, unknown>,
    role?: AgentRole,
    context: AgentToolContext = {},
  ): Promise<AgentToolResult> {
    if (role && !this.roleHasTool(role, tool)) {
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
        const hits = bases.flatMap((b) =>
          this.deps.knowledgeBases!.search({ workspaceId, knowledgeBaseId: b.id, query, topK }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        return { query, results: hits };
      }
      case 'memory_append': {
        const section = requireStr(args.section, 'section');
        const entry = requireStr(args.entry, 'entry');
        const scope = args.scope === 'agent' ? 'agent' : 'workspace';
        if (scope === 'agent') {
          if (!this.deps.agentMemory) throw new AgentisError('VALIDATION_FAILED', 'agent memory service not available');
          if (!context.agentId) throw new AgentisError('VALIDATION_FAILED', 'agent-scoped memory requires an agent identity');
          this.deps.agentMemory.append({ agentId: context.agentId, workspaceId, section, content: entry });
          return { ok: true, scope, section };
        }
        if (!this.deps.workspaceIntelligence) throw new AgentisError('VALIDATION_FAILED', 'workspace memory service not available');
        await this.deps.workspaceIntelligence.appendMemory(workspaceId, section, entry);
        return { ok: true, scope, section };
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
        // No key → return the whole snapshot so an agent can survey prior state.
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
        const inputs = (args.inputs && typeof args.inputs === 'object') ? args.inputs as Record<string, unknown> : {};
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

  /** Naive text search across Volume files (one level of recursion via known dirs). */
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
        if ((e.size ?? 0) > 512_000) continue; // skip large/binary
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
