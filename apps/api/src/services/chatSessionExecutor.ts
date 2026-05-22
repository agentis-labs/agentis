import { randomUUID } from 'node:crypto';
import type { AgentAdapter, ChatDelta, ChatMessage, ChatToolCall, ChatTurnContext, ToolDefinition, ViewportContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { CHAT_TOOL_CATALOG, buildWorkspaceToolCatalog } from './chatToolCatalog.js';
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
  /**
   * Optional native function-calling runtime used to answer chat turns for
   * agents whose own adapter forwards tools via the slow marker protocol
   * (Codex / Claude Code CLIs re-spawn a process per tool round). When set,
   * those turns are token-streamed through this runtime instead — the fast path
   * — while keeping the selected agent's persona, context, and attribution.
   * Unset = every agent uses its own adapter, unchanged.
   */
  orchestratorRuntime?: AgentAdapter;
}

export interface ChatTurnOptions {
  tools?: ToolDefinition[];
  viewport?: ViewportContext | null;
  maxTurns?: number;
  maxToolCalls?: number;
  systemAddendum?: string;
}

interface PendingChatConfirmation {
  turnId: string;
  call: ChatToolCall;
  context: ChatTurnContext;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTurns: number;
  maxToolCalls: number;
  toolCallCount: number;
  createdAt: number;
  expiresAt: number;
}

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export class ChatSessionExecutor {
  static #deps: ChatSessionExecutorDeps = {};
  static #pendingConfirmations = new Map<string, PendingChatConfirmation>();

  static configure(deps: ChatSessionExecutorDeps): void {
    this.#deps = deps;
  }

  /**
   * Resolve which adapter actually answers a chat turn. Agents whose runtime
   * forwards tools via the marker protocol (Codex / Claude Code CLIs) are slow
   * and re-spawn per tool round; when an `orchestratorRuntime` is configured we
   * transparently answer their turns through it instead. Everything else uses
   * its own adapter. The swap is invisible to the operator — same persona,
   * same context, same attribution.
   */
  static #resolveChatAdapter(adapter: AgentAdapter): AgentAdapter {
    const runtime = this.#deps.orchestratorRuntime;
    if (!runtime || runtime === adapter) return adapter;
    const forwarding = adapter.capabilities?.().toolForwarding;
    if (forwarding === 'marker_protocol' && runtime.chat) {
      this.#deps.logger?.debug?.('chat.fast_path.engaged', { from: adapter.adapterType });
      return runtime;
    }
    return adapter;
  }

  /**
   * Build the tool catalog for a turn. When the db is wired we surface the
   * workspace's workflows as discrete `workflow.<id>` tools so the
   * orchestrator can call them directly with typed parameters. Capped at 40
   * to keep the tool list manageable for the model. Falls back to the static
   * catalog if the db is unavailable or the lookup fails.
   */
  static #buildCatalog(ctx: ChatTurnContext): ToolDefinition[] {
    const db = this.#deps.db;
    if (!db || !ctx.workspaceId) return this.#filterToRegistered(CHAT_TOOL_CATALOG);
    try {
      const rows = db
        .select({
          id: schema.workflows.id,
          title: schema.workflows.title,
          summary: schema.workflows.summary,
          graph: schema.workflows.graph,
          updatedAt: schema.workflows.updatedAt,
        })
        .from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, ctx.workspaceId))
        .all()
        // Most-recently-edited first so the cap keeps the workflows the
        // operator is actively working on.
        .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
      if (rows.length === 0) return this.#filterToRegistered(CHAT_TOOL_CATALOG);
      return this.#filterToRegistered(buildWorkspaceToolCatalog(
        rows.slice(0, 40).map((r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          inputContract: (r.graph as { inputContract?: { fields?: Array<{ key: string; type?: string; required?: boolean; description?: string }> } } | null)?.inputContract ?? null,
        })),
      ));
    } catch (err) {
      this.#deps.logger?.warn('chat.catalog.dynamic_failed', { err: (err as Error).message });
      return this.#filterToRegistered(CHAT_TOOL_CATALOG);
    }
  }

  /**
   * Drop any advertised tool the registry can't actually execute, so the model
   * never wastes a turn calling a phantom tool (e.g. `agentis.knowledge.search`
   * advertised in the static catalog but not registered). Dynamic `workflow.<id>`
   * tools are always kept (the executor rewrites them to agentis.workflow.run).
   * If the registry isn't configured yet, returns the catalog unfiltered rather
   * than hiding everything.
   */
  static #filterToRegistered(tools: ToolDefinition[]): ToolDefinition[] {
    const registered = ChatToolExecutor.registeredIds();
    if (registered.size === 0) return tools;
    const kept = tools.filter((tool) => tool.name.startsWith('workflow.') || registered.has(tool.name));
    const dropped = tools.length - kept.length;
    if (dropped > 0) {
      this.#deps.logger?.debug?.('chat.catalog.filtered_unregistered', { dropped });
    }
    return kept;
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
    const tools = options.tools ?? this.#buildCatalog(ctx);
    const viewport = options.viewport ?? ctx.viewport ?? null;

    adapter = this.#resolveChatAdapter(adapter);
    const capabilities = adapter.capabilities?.();
    if (!adapter.chat || capabilities?.interactiveChat === false) {
      const reason = capabilities?.limitations?.[0];
      yield { type: 'text', delta: reason ?? 'This agent adapter is connected for workflow tasks, but it does not expose interactive chat yet.' };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    const baseSystemPrompt = buildOrchestratorSystemPrompt({
      context: { ...ctx, viewport },
      viewport,
      ...this.#loadPromptContext(ctx),
      ...this.#extractInlineContext(userMessage, ctx),
    });
    const systemPrompt = options.systemAddendum?.trim()
      ? `${baseSystemPrompt}\n\n${options.systemAddendum.trim()}`
      : baseSystemPrompt;
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimHistory(history),
      { role: 'user', content: expandUserMessage(userMessage) },
    ];

    yield* this.#executeLoop(adapter, messages, { ...ctx, viewport }, {
      tools,
      maxTurns,
      maxToolCalls,
      startedAt,
      toolCallCount: 0,
    });
  }

  static async *confirm(
    adapter: AgentAdapter,
    turnId: string,
    confirmed: boolean,
    guard: { workspaceId: string; userId: string; conversationId: string },
  ): AsyncIterable<ChatDelta> {
    adapter = this.#resolveChatAdapter(adapter);
    this.#cleanupPendingConfirmations();
    const pending = this.#pendingConfirmations.get(turnId);
    if (!pending) {
      yield { type: 'text', delta: 'That action is no longer waiting for confirmation. Please send the request again.' };
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    if (
      pending.context.workspaceId !== guard.workspaceId ||
      pending.context.userId !== guard.userId ||
      pending.context.conversationId !== guard.conversationId
    ) {
      yield { type: 'text', delta: 'That confirmation belongs to a different conversation.' };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    this.#pendingConfirmations.delete(turnId);

    if (!confirmed) {
      yield { type: 'text', delta: `Canceled. I did not run ${pending.call.name}.` };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    const capabilities = adapter.capabilities?.();
    if (!adapter.chat || capabilities?.interactiveChat === false) {
      yield { type: 'text', delta: capabilities?.limitations?.[0] ?? 'This agent cannot resume the confirmed action because its adapter does not expose interactive chat.' };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    yield { type: 'tool_call', id: pending.call.id, name: pending.call.name, args: pending.call.arguments };
    const executed = await this.#executeToolCall(pending.call, pending.context);
    yield executed.delta;

    const messages = [
      ...pending.messages,
      {
        role: 'tool' as const,
        toolCallId: pending.call.id,
        content: executed.result.error
          ? JSON.stringify({ error: executed.result.error })
          : JSON.stringify(executed.summarized),
      },
    ];

    yield* this.#executeLoop(adapter, messages, pending.context, {
      tools: pending.tools,
      maxTurns: pending.maxTurns,
      maxToolCalls: pending.maxToolCalls,
      startedAt: Date.now(),
      toolCallCount: pending.toolCallCount + 1,
    });
  }

  static async *#executeLoop(
    adapter: AgentAdapter,
    messages: ChatMessage[],
    ctx: ChatTurnContext,
    options: {
      tools: ToolDefinition[];
      maxTurns: number;
      maxToolCalls: number;
      startedAt: number;
      toolCallCount: number;
    },
  ): AsyncIterable<ChatDelta> {
    let toolCallCount = options.toolCallCount;
    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      const toolCalls: ChatToolCall[] = [];
      let assistantText = '';
      let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';

      try {
        for await (const delta of adapter.chat!(messages, options.tools)) {
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
        this.#logTurn(ctx, options.startedAt, toolCallCount, finishReason);
        yield { type: 'done', finishReason };
        return;
      }

      messages.push({ role: 'assistant', content: assistantText, toolCalls });

      // Cap batch to remaining budget before kicking off parallel execution.
      const remaining = options.maxToolCalls - toolCallCount;
      const batch = toolCalls.slice(0, remaining);
      if (batch.length < toolCalls.length) {
        yield { type: 'done', finishReason: 'max_turns' };
        return;
      }

      const confirmationCall = batch.find((call) => ChatToolExecutor.requiresConfirmation(call.name));
      if (confirmationCall) {
        const turnId = randomUUID();
        const now = Date.now();
        const assistantForConfirmation: ChatMessage = {
          role: 'assistant',
          content: assistantText,
          toolCalls: [confirmationCall],
        };
        this.#pendingConfirmations.set(turnId, {
          turnId,
          call: confirmationCall,
          context: ctx,
          messages: [...messages.slice(0, -1), assistantForConfirmation],
          tools: options.tools,
          maxTurns: options.maxTurns,
          maxToolCalls: options.maxToolCalls,
          toolCallCount,
          createdAt: now,
          expiresAt: now + CONFIRMATION_TTL_MS,
        });
        yield this.#buildConfirmationDelta(turnId, confirmationCall, now + CONFIRMATION_TTL_MS);
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'confirmation_required');
        yield { type: 'done', finishReason: 'stop' };
        return;
      }

      toolCallCount += batch.length;

      // Execute all tool calls in parallel — SQLite builtins are sub-ms, HTTP
      // tools can take hundreds of ms. Parallel execution is the spec §6.2 design.
      const settled = await Promise.all(
        batch.map((call) => this.#executeToolCall(call, ctx)),
      );

      for (const { call, result, summarized, delta } of settled) {
        yield delta;
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: result.error
            ? JSON.stringify({ error: result.error })
            : JSON.stringify(summarized),
        });
      }
    }

    this.#logTurn(ctx, options.startedAt, toolCallCount, 'max_turns');
    yield { type: 'done', finishReason: 'max_turns' };
  }

  static async #executeToolCall(call: ChatToolCall, ctx: ChatTurnContext) {
    const toolStartedAt = Date.now();
    const result = await ChatToolExecutor.run(call.name, call.arguments, ctx);
    const durationMs = Date.now() - toolStartedAt;
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
    return {
      call,
      result,
      summarized,
      durationMs,
      delta: {
        type: 'tool_result' as const,
        id: call.id,
        name: call.name,
        result: summarized,
        ...(result.error ? { error: result.error } : {}),
      },
    };
  }

  static #buildConfirmationDelta(turnId: string, call: ChatToolCall, expiresAt: number): Extract<ChatDelta, { type: 'confirmation_required' }> {
    const title = confirmationTitle(call.name);
    const definition = ChatToolExecutor.definition(call.name);
    const impact = confirmationImpact(call.name, call.arguments, definition?.description);
    const args = safeJson(call.arguments);
    const clippedArgs = args.length > 900 ? `${args.slice(0, 900)}...` : args;
    return {
      type: 'confirmation_required',
      turnId,
      toolCall: { id: call.id, name: call.name, args: call.arguments },
      title,
      body: [
        impact.summary,
        '',
        ...(impact.details.length > 0 ? ['Action details:', ...impact.details.map((detail) => `- ${detail}`), ''] : []),
        `Arguments:\n${clippedArgs}`,
      ].join('\n'),
      impact,
      confirmLabel: confirmationConfirmLabel(call.name),
      cancelLabel: 'Cancel',
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  static #cleanupPendingConfirmations(): void {
    const now = Date.now();
    for (const [turnId, pending] of this.#pendingConfirmations) {
      if (pending.expiresAt <= now) this.#pendingConfirmations.delete(turnId);
    }
  }

  static #loadPromptContext(ctx: ChatTurnContext) {
    const db = this.#deps.db;
    if (!db) return {};
    const workspace = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).get();
    const agent = db.select().from(schema.agents).where(eq(schema.agents.id, ctx.agentId)).get();
    const agentInventory = db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspaceId)).all()
      .map((row) => ({ id: row.id, name: row.name, status: row.status, adapterType: row.adapterType }));
    const activeRuns = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workspaceId, ctx.workspaceId)).all()
      .filter((run) => run.status === 'RUNNING')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((run) => ({ id: run.id, workflowId: run.workflowId ?? `ephemeral:${run.id}`, status: run.status, createdAt: run.createdAt }));
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
      .map((registration) => ({
        agentId: registration.agentId,
        adapterType: registration.adapterType,
        capabilities: registration.adapter.capabilities?.() ?? null,
      })) ?? [];
    return {
      workspaceName: workspace?.name,
      agentName: agent?.name,
      agentInventory,
      activeRuns,
      pendingApprovals,
      gatewayHealth: { gateways, registeredAdapters: adapterHealth },
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
          name: run.workflowId ?? run.ephemeralTitle ?? `ephemeral:${run.id}`,
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
    newapp: `The operator used /newapp from the Apps page. They want to create a new Agentis app through chat. Ask what the app should do if the request is empty. If the goal is clear, propose a short app plan with name, entry workflow, expected output, and any missing connections. Only after the operator confirms, call agentis.app.create. Request: ${rest}`,
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

function confirmationTitle(toolName: string): string {
  const titles: Record<string, string> = {
    'agentis.workflow.run': 'Run workflow?',
    'agentis.run.cancel': 'Cancel run?',
    'agentis.approval.resolve': 'Resolve approval?',
    'agentis.app.thread.append': 'Update app thread?',
    'agentis.app.create': 'Create app?',
    'agentis.ephemeral.run': 'Run ephemeral workflow?',
  };
  return titles[toolName] ?? 'Confirm platform action?';
}

function confirmationConfirmLabel(toolName: string): string {
  const labels: Record<string, string> = {
    'agentis.workflow.run': 'Run workflow',
    'agentis.run.cancel': 'Cancel run',
    'agentis.approval.resolve': 'Resolve approval',
    'agentis.app.thread.append': 'Update thread',
    'agentis.app.create': 'Create app',
    'agentis.ephemeral.run': 'Run once',
  };
  return labels[toolName] ?? 'Confirm';
}

function confirmationImpact(toolName: string, args: unknown, fallbackDescription?: string): {
  summary: string;
  details: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'danger';
  reversible: boolean;
  externalSideEffects: boolean;
} {
  const record = recordFromUnknown(args);
  const details: string[] = [];
  const workflowId = stringFrom(record.workflowId);
  const runId = stringFrom(record.runId);
  const approvalId = stringFrom(record.approvalId);
  const decision = stringFrom(record.decision);
  const dynamicWorkflowId = toolName.startsWith('workflow.') ? toolName.slice('workflow.'.length) : null;

  if (workflowId || dynamicWorkflowId) details.push(`Workflow: ${workflowId ?? dynamicWorkflowId}`);
  if (runId) details.push(`Run: ${runId}`);
  if (approvalId) details.push(`Approval: ${approvalId}`);
  if (decision) details.push(`Decision: ${decision}`);

  if (toolName === 'agentis.workflow.run' || toolName.startsWith('workflow.')) {
    return {
      summary: 'This will start a real workflow run in the current workspace.',
      details: [
        ...details,
        'The workflow may execute agents, skills, integrations, or checkpoints depending on its graph.',
      ],
      riskLevel: 'medium',
      reversible: false,
      externalSideEffects: true,
    };
  }

  if (toolName === 'agentis.ephemeral.run') {
    return {
      summary: 'This will execute a temporary workflow graph once without saving it first.',
      details: [
        ...details,
        'Any side effects inside the graph still happen during the run.',
      ],
      riskLevel: 'medium',
      reversible: false,
      externalSideEffects: true,
    };
  }

  if (toolName === 'agentis.run.cancel') {
    return {
      summary: 'This will stop an active workflow run and mark unfinished nodes as cancelled.',
      details,
      riskLevel: 'high',
      reversible: false,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.approval.resolve') {
    return {
      summary: `This will ${decision === 'reject' ? 'reject' : 'approve'} a pending human approval.`,
      details: [
        ...details,
        'The waiting workflow may immediately continue or stop based on this decision.',
      ],
      riskLevel: decision === 'reject' ? 'danger' : 'high',
      reversible: false,
      externalSideEffects: true,
    };
  }

  if (toolName === 'agentis.app.create') {
    return {
      summary: 'This will create a deployed Agentis app and associated platform resources.',
      details,
      riskLevel: 'medium',
      reversible: true,
      externalSideEffects: false,
    };
  }

  return {
    summary: fallbackDescription ?? 'This action changes platform state.',
    details,
    riskLevel: 'medium',
    reversible: false,
    externalSideEffects: false,
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
