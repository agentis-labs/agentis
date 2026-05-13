import type { AgentAdapter, ChatDelta, ChatMessage, ChatToolCall, ChatTurnContext, ToolDefinition, ViewportContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq, inArray } from 'drizzle-orm';
import { CHAT_TOOL_CATALOG } from './chatToolCatalog.js';
import { ChatToolExecutor } from './chatToolExecutor.js';
import { buildOrchestratorSystemPrompt } from './orchestratorPrompt.js';
import { recordToolCall } from './chatMetrics.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';

export interface ChatSessionExecutorDeps {
  db?: AgentisSqliteDb;
  logger?: Logger;
  bus?: EventBus;
  adapters?: AdapterManager;
}

export interface ChatTurnOptions {
  tools?: ToolDefinition[];
  viewport?: ViewportContext | null;
  maxTurns?: number;
  maxToolCalls?: number;
}

export class ChatSessionExecutor {
  static #deps: ChatSessionExecutorDeps = {};

  static configure(deps: ChatSessionExecutorDeps): void {
    this.#deps = deps;
  }

  static async *turn(
    adapter: AgentAdapter,
    history: ChatMessage[],
    userMessage: string,
    ctx: ChatTurnContext,
    options: ChatTurnOptions = {},
  ): AsyncIterable<ChatDelta> {
    const startedAt = Date.now();
    const maxTurns = Math.max(1, Math.min(options.maxTurns ?? ctx.maxTurns ?? 5, 8));
    const maxToolCalls = Math.max(1, Math.min(options.maxToolCalls ?? 12, 24));
    const tools = options.tools ?? CHAT_TOOL_CATALOG;
    const viewport = options.viewport ?? ctx.viewport ?? null;

    if (!adapter.chat) {
      yield { type: 'text', delta: 'This agent adapter is connected for workflow tasks, but it does not expose interactive chat yet.' };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    const systemPrompt = buildOrchestratorSystemPrompt({
      context: { ...ctx, viewport },
      viewport,
      ...this.#loadPromptContext(ctx),
      ...this.#extractInlineContext(userMessage, ctx),
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimHistory(history),
      { role: 'user', content: expandUserMessage(userMessage) },
    ];

    let toolCallCount = 0;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const toolCalls: ChatToolCall[] = [];
      let assistantText = '';
      let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';

      try {
        for await (const delta of adapter.chat(messages, tools)) {
          if (delta.type === 'text') assistantText += delta.delta;
          if (delta.type === 'tool_call') toolCalls.push({ id: delta.id, name: delta.name, arguments: delta.args });
          if (delta.type === 'done') {
            finishReason = delta.finishReason;
            continue;
          }
          yield delta;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#deps.logger?.warn('chat.turn.adapter_failed', { agentId: ctx.agentId, err: message });
        yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message };
        yield { type: 'done', finishReason: 'error' };
        return;
      }

      if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
        this.#logTurn(ctx, startedAt, toolCallCount, finishReason);
        yield { type: 'done', finishReason };
        return;
      }

      messages.push({ role: 'assistant', content: assistantText, toolCalls });

      // Cap batch to remaining budget before kicking off parallel execution.
      const remaining = maxToolCalls - toolCallCount;
      const batch = toolCalls.slice(0, remaining);
      if (batch.length < toolCalls.length) {
        yield { type: 'done', finishReason: 'max_turns' };
        return;
      }
      toolCallCount += batch.length;

      // Execute all tool calls in parallel — SQLite builtins are sub-ms, HTTP
      // tools can take hundreds of ms. Parallel execution is the spec §6.2 design.
      const callCtx = { ...ctx, viewport };
      const settled = await Promise.all(
        batch.map(async (call) => {
          const toolStartedAt = Date.now();
          const result = await ChatToolExecutor.run(call.name, call.arguments, callCtx);
          return { call, result, durationMs: Date.now() - toolStartedAt };
        }),
      );

      for (const { call, result, durationMs } of settled) {
        const summarized = summarizeToolResult(result.data ?? result.error ?? null);
        const ok = !result.error;
        recordToolCall(call.name, durationMs, ok);
        this.#deps.logger?.info('chat.tool_call', {
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          tool: call.name,
          ok,
          durationMs,
        });
        yield {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          result: summarized,
          ...(result.error ? { error: result.error } : {}),
        };
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: result.error
            ? JSON.stringify({ error: result.error })
            : JSON.stringify(summarized),
        });
      }
    }

    this.#logTurn(ctx, startedAt, toolCallCount, 'max_turns');
    yield { type: 'done', finishReason: 'max_turns' };
  }

  static #loadPromptContext(ctx: ChatTurnContext) {
    const db = this.#deps.db;
    if (!db) return {};
    const workspace = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).get();
    const agent = db.select().from(schema.agents).where(eq(schema.agents.id, ctx.agentId)).get();
    const agentInventory = db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspaceId)).all()
      .map((row) => ({ id: row.id, name: row.name, status: row.status, adapterType: row.adapterType }));
    const activeRuns = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workspaceId, ctx.workspaceId)).all()
      .filter((run) => ['CREATED', 'RUNNING', 'WAITING', 'PAUSED_FOR_APPROVAL'].includes(run.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((run) => ({ id: run.id, workflowId: run.workflowId, status: run.status, createdAt: run.createdAt }));
    const pendingApprovals = db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.workspaceId, ctx.workspaceId)).all()
      .filter((approval) => approval.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((approval) => ({ id: approval.id, title: approval.title, summary: approval.summary }));
    const gateways = db.select().from(schema.openclawGateways).where(eq(schema.openclawGateways.workspaceId, ctx.workspaceId)).all()
      .map((gateway) => ({
        id: gateway.id,
        name: gateway.name,
        status: gateway.status,
        lastHeartbeatAt: gateway.lastHeartbeatAt,
      }));
    const adapterHealth = this.#deps.adapters?.list()
      .filter((registration) => agentInventory.some((agentRow) => agentRow.id === registration.agentId))
      .map((registration) => ({ agentId: registration.agentId, adapterType: registration.adapterType })) ?? [];
    const turnCosts = db.select().from(schema.turnState).where(eq(schema.turnState.workspaceId, ctx.workspaceId)).all()
      .reduce((sum, row) => sum + (row.costCents ?? 0), 0);
    const evaluatorCosts = db.select().from(schema.runEvaluations).where(eq(schema.runEvaluations.workspaceId, ctx.workspaceId)).all()
      .reduce((sum, row) => sum + (row.costCents ?? 0), 0);
    return {
      workspaceName: workspace?.name,
      agentName: agent?.name,
      agentInventory,
      activeRuns,
      pendingApprovals,
      gatewayHealth: { gateways, registeredAdapters: adapterHealth },
      budgetSnapshot: { totalRecordedCostCents: turnCosts + evaluatorCosts, turnCostCents: turnCosts, evaluatorCostCents: evaluatorCosts },
    };
  }

  /**
   * Scan the user message for `@AgentName` and `#resourceRef` tokens.
   * Looks each up in the DB and returns structured context to inject into the
   * system prompt — this is the §6 @mention / #resource context injection.
   */
  static #extractInlineContext(
    userMessage: string,
    ctx: ChatTurnContext,
  ): { mentionedAgents: Array<{ id: string; name: string; adapterType: string | null; status: string | null; instructions: string | null }>; referencedResources: Array<{ kind: string; id: string; name: string; detail: string }> } {
    const db = this.#deps.db;
    if (!db) return { mentionedAgents: [], referencedResources: [] };

    // @AgentName — match words like @Foo or @Foo_Bar (underscores from autocomplete)
    const mentionNames = Array.from(
      new Set((userMessage.match(/@([\w_-]+)/g) ?? []).map((m) => m.slice(1).replace(/_/g, ' '))),
    );
    const mentionedAgents: Array<{ id: string; name: string; adapterType: string | null; status: string | null; instructions: string | null }> = [];
    for (const rawName of mentionNames) {
      const row = db.select().from(schema.agents)
        .where(eq(schema.agents.workspaceId, ctx.workspaceId))
        .all()
        .find((a) => a.name.toLowerCase() === rawName.toLowerCase());
      if (row) {
        mentionedAgents.push({
          id: row.id,
          name: row.name,
          adapterType: row.adapterType ?? null,
          status: row.status ?? null,
          instructions: row.instructions ? row.instructions.slice(0, 400) : null,
        });
      }
    }

    // #resourceRef — try to match workflow name or run ID
    const resourceRefs = Array.from(
      new Set((userMessage.match(/#([\w_-]+)/g) ?? []).map((m) => m.slice(1))),
    );
    const referencedResources: Array<{ kind: string; id: string; name: string; detail: string }> = [];
    for (const ref of resourceRefs) {
      // Try run ID first (run_ prefix or uuid-like)
      const run = db.select().from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.workspaceId, ctx.workspaceId))
        .all()
        .find((r) => r.id === ref || r.id.startsWith(ref));
      if (run) {
        referencedResources.push({
          kind: 'run',
          id: run.id,
          name: run.workflowId,
          detail: `status=${run.status} createdAt=${run.createdAt}`,
        });
        continue;
      }
      // Try workflow by name (workflows use `title`)
      const wf = db.select().from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, ctx.workspaceId))
        .all()
        .find((w) => w.title.toLowerCase().replace(/\s+/g, '_') === ref.toLowerCase() || w.id === ref);
      if (wf) {
        referencedResources.push({
          kind: 'workflow',
          id: wf.id,
          name: wf.title,
          detail: `id=${wf.id}`,
        });
      }
    }

    return { mentionedAgents, referencedResources };
  }

  static #logTurn(ctx: ChatTurnContext, startedAt: number, toolCalls: number, finishReason: string) {
    this.#deps.logger?.info('chat.turn.completed', {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      finishReason,
      toolCalls,
      durationMs: Date.now() - startedAt,
    });
  }
}

function trimHistory(history: ChatMessage[]): ChatMessage[] {
  return history
    .filter((message) => message.role !== 'system')
    .slice(-40);
}

function expandUserMessage(message: string): string {
  if (!message.startsWith('/')) return message;
  const match = message.match(/^\/(\w+)\s*(.*)$/);
  if (!match) return message;
  const [, command, rest = ''] = match;
  const mapping: Record<string, string> = {
    run: `The operator used /run. Resolve the workflow they mean, then use agentis.workflow.run when safe. Request missing IDs instead of guessing. Request: ${rest}`,
    approve: `The operator used /approve. List pending approvals, identify the intended approval, and only resolve it if the instruction is explicit. Request: ${rest}`,
    status: `The operator used /status. Summarize current runs, agents, gateways, and approvals using tools. Request: ${rest}`,
    history: `The operator used /history. Query recent runs and audit trails relevant to: ${rest}`,
    help: 'The operator used /help. Briefly explain what the Agentis orchestrator can do through chat.',
  };
  return mapping[command?.toLowerCase() ?? ''] ?? message;
}

function summarizeToolResult(value: unknown): unknown {
  const text = typeof value === 'string' ? value : safeJson(value);
  if (text.length <= 2000) return value;
  return {
    summary: text.slice(0, 1800),
    truncated: true,
    originalLength: text.length,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}