import { randomUUID } from 'node:crypto';
import type { AgentAdapter, ChatDelta, ChatInvocationOptions, ChatMessage, ChatToolCall, ChatTurnContext, ToolDefinition, ViewportContext } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { CHAT_TOOL_CATALOG, buildWorkspaceToolCatalog } from './chatToolCatalog.js';
import { ChatToolExecutor } from './chatToolExecutor.js';
import { buildOrchestratorSystemPrompt, responseProfileForChannel } from './orchestratorPrompt.js';
import type { WorkspaceAwarenessService } from './workspaceAwarenessService.js';
import type { OrchestratorModelRouter } from './orchestratorModelRouter.js';
import { recordToolCall, recordTurn } from './chatMetrics.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { AgentMemoryService } from './agentMemory.js';
import type { PersonalBrainService } from './personalBrain.js';
import type { WorkspaceIntelligenceService } from './workspaceIntelligence.js';
import type { KnowledgeBaseService } from './knowledgeBase.js';
import type { BrainDiscourseService } from './brainDiscourseService.js';
import type { AbilityService } from './abilityService.js';

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
  /**
   * Per-role model router. When set, the conversation runtime is resolved from
   * it per workspace (honoring per-workspace model overrides) instead of the
   * static `orchestratorRuntime`. Falls back to `orchestratorRuntime`.
   */
  modelRouter?: OrchestratorModelRouter;
  agentMemory?: AgentMemoryService;
  personalBrain?: PersonalBrainService;
  workspaceIntelligence?: WorkspaceIntelligenceService;
  knowledgeBases?: KnowledgeBaseService;
  brainDiscourse?: BrainDiscourseService;
  awareness?: WorkspaceAwarenessService;
  abilityService?: AbilityService;
}

export interface ChannelTurnContext {
  kind: string;
  from?: string | null;
  chatId?: string | null;
  threadId?: string | null;
  /** "Who is this" recall across channels (ChannelIdentityService). */
  senderSummary?: string | null;
}

export interface ChatTurnOptions {
  tools?: ToolDefinition[];
  viewport?: ViewportContext | null;
  maxTurns?: number;
  maxToolCalls?: number;
  systemAddendum?: string;
  /** Set when the turn originates from a messaging channel (OMNICHANNEL §4). */
  channelContext?: ChannelTurnContext | null;
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
  /** Conversations already warned that they're on the slow CLI fast-path (warn once). */
  static #slowPathWarned = new Set<string>();

  static configure(deps: ChatSessionExecutorDeps): void {
    this.#deps = deps;
  }

  /**
   * The configured orchestrator runtime (native function-calling brain), if any.
   * Channel turns whose bound agent has no chat-capable adapter of its own fall
   * back to this so the orchestrator can still answer over the channel.
   */
  static orchestratorAdapter(workspaceId?: string): AgentAdapter | undefined {
    return this.#deps.modelRouter?.resolve('conversation', workspaceId) ?? this.#deps.orchestratorRuntime;
  }

  /**
   * Resolve which adapter actually answers a chat turn. Agents backed by a CLI
   * harness are slow for conversation: a `marker_protocol` harness re-spawns per
   * tool round, and an `mcp_native` harness cold-starts a whole agentic loop for
   * every turn. When an `orchestratorRuntime` is configured we transparently
   * answer BOTH kinds through it — the fast streaming path — instead. Everything
   * else (native function-calling adapters) uses its own adapter. The swap is
   * invisible to the operator — same persona, same context, same attribution.
   *
   * NOTE: `mcp_native` was added here deliberately. Enabling MCP on a Codex /
   * Claude Code agent flips its `toolForwarding` from `marker_protocol` to
   * `mcp_native`; before this it silently fell through to the slow CLI path,
   * making chat 3–4× slower after MCP was turned on. Both now fast-path.
   */
  static #resolveChatAdapter(adapter: AgentAdapter, workspaceId?: string): AgentAdapter {
    const runtime = this.#deps.modelRouter?.resolve('conversation', workspaceId) ?? this.#deps.orchestratorRuntime;
    if (!runtime || runtime === adapter) return adapter;
    const forwarding = adapter.capabilities?.().toolForwarding;
    if ((forwarding === 'marker_protocol' || forwarding === 'mcp_native') && runtime.chat) {
      this.#deps.logger?.debug?.('chat.fast_path.engaged', { from: adapter.adapterType, forwarding });
      return runtime;
    }
    return adapter;
  }

  /**
   * Build the tool catalog for a turn. The always-on platform verbs (run/status/
   * approve/…) come from the static catalog; on top we surface the workspace's
   * workflows as discrete `workflow.<id>` tools so the orchestrator can call them
   * with typed parameters. The dynamic set is capped small (WORKFLOW_TOOL_CAP)
   * and ranked by relevance — the viewport's active workflow first, then
   * most-recently-edited — because dumping dozens of tools inflates the prompt
   * and slows tool selection on every turn. Falls back to the static catalog if
   * the db is unavailable or the lookup fails.
   */
  static #buildCatalog(ctx: ChatTurnContext): ToolDefinition[] {
    const db = this.#deps.db;
    if (!db || !ctx.workspaceId) return this.#filterToRegistered(CHAT_TOOL_CATALOG);
    try {
      const rows = db
        .select({
          id: schema.workflows.id,
          title: schema.workflows.title,
          description: schema.workflows.description,
          graph: schema.workflows.graph,
          updatedAt: schema.workflows.updatedAt,
        })
        .from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, ctx.workspaceId))
        .all();
      if (rows.length === 0) return this.#filterToRegistered(CHAT_TOOL_CATALOG);
      // The workflow the operator is currently looking at is the one they're most
      // likely to mean — always include it, then fill the rest by recency.
      const activeWorkflowId = workflowIdFromViewport(ctx.viewport);
      const ranked = rows.sort((a, b) => {
        if (a.id === activeWorkflowId) return -1;
        if (b.id === activeWorkflowId) return 1;
        return a.updatedAt > b.updatedAt ? -1 : 1;
      });
      return this.#filterToRegistered(buildWorkspaceToolCatalog(
        ranked.slice(0, WORKFLOW_TOOL_CAP).map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
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
    const viewport = options.viewport ?? ctx.viewport ?? null;
    const expandedUserMessage = expandUserMessage(userMessage);
    // Social turns cannot need platform actions. Leaving the catalog empty also
    // lets CLI harnesses skip MCP startup, removing its process/handshake cost.
    const lightweightConversation = isLightweightConversation(userMessage);
    const tools = options.tools ?? (lightweightConversation ? [] : this.#buildCatalog(ctx));
    let effectiveUserMessage = expandedUserMessage;
    let brainSystemInjection: string | null = null;
    let abilitySystemInjection: string | null = null;

    if (userMessage.startsWith('/') && this.#deps.abilityService) {
      const match = userMessage.match(/^\/(\w+)\s*(.*)$/);
      if (match) {
        const wId = ctx.workspaceId;
        if (wId) {
          const ability = this.#deps.abilityService.findBySlashCommand(wId as string, match[1] as string);
          if (ability) {
            abilitySystemInjection = `The operator triggered the /${match[1]} command. Apply the following ability rules:\n\n${ability.compiledPrompt || ability.description}\n\n`;
            effectiveUserMessage = match[2] ? match[2] : `Execute the /${match[1]} command.`;
          }
        }
      }
    }

    const agentAdapter = adapter;
    adapter = this.#resolveChatAdapter(adapter, ctx.workspaceId);
    // Developer observability (not a user prompt — the harness is the intended
    // default brain). A marker-protocol CLI harness (Codex / Claude Code) re-spawns
    // per tool round, so multi-step tasks pay a per-round cold-start. Note it once
    // per conversation; pointing a Conversation model at a streaming endpoint in
    // Settings → Runtimes is an OPTIONAL speed-up, never a required second setup.
    const agentForwarding = agentAdapter.capabilities?.().toolForwarding;
    if (adapter === agentAdapter && (agentForwarding === 'marker_protocol' || agentForwarding === 'mcp_native')) {
      const key = ctx.conversationId ?? ctx.agentId;
      if (!ChatSessionExecutor.#slowPathWarned.has(key)) {
        ChatSessionExecutor.#slowPathWarned.add(key);
        this.#deps.logger?.info?.(`chat.harness.${agentForwarding}`, {
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          adapterType: agentAdapter.adapterType,
          note: agentForwarding === 'mcp_native'
            ? 'Answering on the agent\'s harness with Agentis tools mounted natively over MCP (single streaming invocation).'
            : 'Answering on the agent\'s CLI harness (re-spawns per tool round). Optional: set a streaming Conversation model in Settings → Runtimes for a faster path.',
        });
      }
    }

    const directBuild = parseDirectWorkflowMutationIntent(userMessage, viewport);
    if (directBuild && ChatToolExecutor.registeredIds().has('agentis.build_workflow')) {
      yield* this.#executeDirectWorkflowBuild(ctx, startedAt, directBuild);
      return;
    }

    const capabilities = adapter.capabilities?.();
    if (!adapter.chat || capabilities?.interactiveChat === false) {
      const reason = capabilities?.limitations?.[0];
      yield { type: 'text', delta: reason ?? 'This agent adapter is connected for workflow tasks, but it does not expose interactive chat yet.' };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    yield this.#activity(ctx, 'context', 'Loading workspace context', 'Collecting viewport, memory, tools, and agent instructions.', 'context');
    const promptCtx = this.#loadPromptContext(ctx);
    const logger = this.#deps.logger;

    // agentMemory is a synchronous local SQLite read — cheap, leave inline.
    let agentMemory: string | null = null;
    if (ctx.agentId && this.#deps.agentMemory) {
      try {
        agentMemory = this.#deps.agentMemory.contextSection(ctx.agentId, ctx.workspaceId);
      } catch (err) {
        logger?.warn?.('chat.agent_memory.failed', { agentId: ctx.agentId, err: (err as Error).message });
      }
    }

    // The three remote/expensive retrievers — brain discourse, personal brain,
    // and workspace intelligence (which fires a knowledge-base embedding search)
    // — run CONCURRENTLY and each time-boxed via withBudget. A slow or failed
    // retriever degrades to "omitted" instead of blocking the turn, so per-turn
    // context cost is max(builders) capped at the budget, not the serial sum.
    // Knowledge retrieval is additionally gated on the message carrying a real
    // query signal, so trivial chatter never pays for an embedding round-trip.
    const brainDiscourse = this.#deps.brainDiscourse;
    const personalBrainDep = this.#deps.personalBrain;
    const workspaceIntelligence = this.#deps.workspaceIntelligence;
    const knowledgeBases = this.#deps.knowledgeBases;
    const wantKnowledge = hasRetrievalSignal(userMessage);

    const [discourse, personalBrain, workspaceContext] = await Promise.all([
      !lightweightConversation && brainDiscourse
        ? withBudget(async () => {
            try {
              const d = await brainDiscourse.buildTurn({
                workspaceId: ctx.workspaceId,
                scopeId: ctx.agentId,
                sessionId: ctx.conversationId,
                userId: ctx.userId,
                agentId: ctx.agentId,
                turnCount: countUserTurns(history) + 1,
                userMessage: expandedUserMessage,
                recentMessages: history.map(historyMessageText).filter(Boolean).slice(-8),
              });
              return { injectedMessage: d.injectedMessage, systemInjection: d.systemInjection || null };
            } catch (err) {
              logger?.warn?.('chat.brain_discourse.failed', { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId, err: (err as Error).message });
              return null;
            }
          }, CONTEXT_BUILDER_BUDGET_MS, null, () => logger?.warn?.('chat.brain_discourse.budget_exceeded', { workspaceId: ctx.workspaceId }))
        : Promise.resolve(null),

      !lightweightConversation && ctx.agentId && personalBrainDep
        ? withBudget(async () => {
            try {
              return await personalBrainDep.contextForAgent(ctx.userId, ctx.agentId, userMessage);
            } catch (err) {
              logger?.warn?.('chat.personal_brain.failed', { agentId: ctx.agentId, err: (err as Error).message });
              return null;
            }
          }, CONTEXT_BUILDER_BUDGET_MS, null, () => logger?.warn?.('chat.personal_brain.budget_exceeded', { agentId: ctx.agentId }))
        : Promise.resolve<string | null>(null),

      !lightweightConversation && workspaceIntelligence
        ? withBudget(async () => {
            try {
              return await workspaceIntelligence.buildContextBlock(ctx.workspaceId, {
                knowledgeQuery: wantKnowledge ? (userMessage || undefined) : undefined,
                knowledgeBases,
              });
            } catch (err) {
              logger?.warn?.('chat.workspace_context.failed', { workspaceId: ctx.workspaceId, err: (err as Error).message });
              return null;
            }
          }, CONTEXT_BUILDER_BUDGET_MS, null, () => logger?.warn?.('chat.workspace_context.budget_exceeded', { workspaceId: ctx.workspaceId }))
        : Promise.resolve<string | null>(null),
    ]);

    if (discourse) {
      effectiveUserMessage = discourse.injectedMessage;
      brainSystemInjection = discourse.systemInjection;
    }

    let agentInstructions: string | null = null;
    const db = this.#deps.db;
    if (db && ctx.agentId) {
      try {
        const agent = db.select().from(schema.agents).where(eq(schema.agents.id, ctx.agentId)).get();
        if (agent?.instructions) {
          agentInstructions = agent.instructions;
        }
      } catch (err) {
        this.#deps.logger?.warn?.('chat.agent_instructions.failed', { agentId: ctx.agentId, err: (err as Error).message });
      }
    }

    // Channel turns lead with workspace situational awareness instead of a
    // viewport, and shape their output for the surface (OMNICHANNEL §4.1/§4.3).
    const channelContext = options.channelContext ?? null;
    let situationalModel: string | null = null;
    if (channelContext && this.#deps.awareness) {
      try {
        situationalModel = this.#deps.awareness.buildContextBlock(ctx.workspaceId) || null;
      } catch (err) {
        this.#deps.logger?.warn?.('chat.awareness.failed', { workspaceId: ctx.workspaceId, err: (err as Error).message });
      }
    }
    const responseProfile = channelContext ? responseProfileForChannel(channelContext.kind) : null;

    // Constant prompt size: clamp every injected block that GROWS with accumulated
    // workspace state (memory, brain notes, knowledge, situational model) to a
    // fixed char budget. This keeps per-turn token cost flat over the lifetime of
    // a workspace — retrievers are mostly top-K already, but this is the single
    // guarantee that they can never bloat the prompt. (Agent instructions are
    // user-authored and fixed-size, so they're left intact.)
    const baseSystemPrompt = buildOrchestratorSystemPrompt({
      context: { ...ctx, viewport },
      viewport,
      // mcp_native harnesses discover the live tool surface over MCP; injecting
      // the full static platform manual just dilutes the agent's own identity.
      toolSurface: capabilities?.toolForwarding === 'mcp_native' && !lightweightConversation ? 'mcp_native' : 'injected',
      ...promptCtx,
      ...this.#extractInlineContext(userMessage, ctx),
      agentInstructions,
      agentMemory: clampBlock(agentMemory, CONTEXT_BUDGET.agentMemory),
      personalBrain: clampBlock(personalBrain, CONTEXT_BUDGET.personalBrain),
      workspaceContext: clampBlock(workspaceContext, CONTEXT_BUDGET.workspaceContext),
      channelContext,
      situationalModel: clampBlock(situationalModel, CONTEXT_BUDGET.situationalModel),
      responseProfile,
    });
    const systemAddendum = [clampBlock(brainSystemInjection, CONTEXT_BUDGET.brainInjection), abilitySystemInjection, options.systemAddendum]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const systemPrompt = systemAddendum.length > 0
      ? `${baseSystemPrompt}\n\n${systemAddendum.join('\n\n')}`
      : baseSystemPrompt;
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimHistory(history),
      { role: 'user', content: effectiveUserMessage },
    ];

    yield this.#activity(ctx, 'runtime', 'Invoking agent runtime', 'Streaming the turn through the selected chat harness.', 'runtime');
    // Context is fully assembled here; everything after is model + tools. This is
    // the boundary the CLB trace measures as `contextMs` (Phase A instrumentation).
    yield* this.#executeLoop(adapter, messages, { ...ctx, viewport }, {
      tools,
      maxTurns,
      maxToolCalls,
      startedAt,
      toolCallCount: 0,
      contextMs: Date.now() - startedAt,
      fastPath: adapter !== agentAdapter,
      adapterType: adapter.adapterType ?? 'unknown',
      lightweightConversation,
      // The agent's own harness should answer on the model the operator picked in
      // the UI — not whatever default the harness happens to boot with.
      preferredModel: adapter === agentAdapter && 'agentRuntimeModel' in promptCtx ? promptCtx.agentRuntimeModel : null,
    });
  }

  static async *confirm(
    adapter: AgentAdapter,
    turnId: string,
    confirmed: boolean,
    guard: { workspaceId: string; userId: string; conversationId: string; signal?: AbortSignal },
  ): AsyncIterable<ChatDelta> {
    adapter = this.#resolveChatAdapter(adapter, guard.workspaceId);
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

    // Resume under THIS request's lifetime, not the original turn's: the stored
    // context's signal belongs to a request that has already ended (it would read
    // as aborted and instantly bail). Override with the confirm request's signal.
    const resumeCtx: ChatTurnContext = { ...pending.context, signal: guard.signal };

    yield { type: 'tool_call', id: pending.call.id, name: pending.call.name, args: pending.call.arguments };
    const executed = await this.#executeToolCall(pending.call, resumeCtx);
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

    yield* this.#executeLoop(adapter, messages, resumeCtx, {
      tools: pending.tools,
      maxTurns: pending.maxTurns,
      maxToolCalls: pending.maxToolCalls,
      startedAt: Date.now(),
      toolCallCount: pending.toolCallCount + 1,
      contextMs: null, // resume after a confirmation — no context-build phase
      fastPath: false,
      adapterType: adapter.adapterType ?? 'unknown',
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
      /** Context-build wall-clock from `turn()`; null on a confirmation resume. */
      contextMs: number | null;
      /** Whether this turn is answered through the orchestrator fast-path. */
      fastPath: boolean;
      adapterType: string;
      /** Skip native MCP startup for turns that cannot need platform actions. */
      lightweightConversation?: boolean;
      /** The agent's UI-selected runtime model, forwarded to the adapter per call. */
      preferredModel?: string | null;
    },
  ): AsyncIterable<ChatDelta> {
    let toolCallCount = options.toolCallCount;
    // CLB stage timers (Phase A). firstTokenMs is the perceived latency; modelMs
    // and toolMs accumulate wall-clock across rounds so the trace shows exactly
    // where an N-round turn spends its time.
    const timings: TurnTimings = {
      contextMs: options.contextMs,
      firstTokenMs: null,
      modelMs: 0,
      toolMs: 0,
      rounds: 0,
      fastPath: options.fastPath,
      adapterType: options.adapterType,
    };
    // Whether ANY assistant text has been streamed across all rounds of this
    // turn. Used to guarantee the turn never ends silently — if we reach a
    // terminal state having shown the operator nothing, we emit an honest
    // summary instead of a bare `done` (which the UI renders as a stuck "?").
    let producedText = false;
    // Whether the model streamed reasoning (chain-of-thought) this turn. A turn
    // that reasoned but emitted no answer is a reasoning model spending its whole
    // budget thinking — recoverable with one more pass, not a dead end.
    let producedThinking = false;
    // One-shot recovery guard + the bumped output budget used on the retry.
    let emptyRetryUsed = false;
    let retryMaxTokens: number | undefined;
    // Per-round + whole-turn budgets are ADAPTER-DERIVED, not one-size-fits-all. A
    // CLI harness (Codex / Claude Code — `marker_protocol` or `mcp_native`) re-spawns
    // the binary every round: a cold process start + model reasoning + (marker
    // protocol) a tool marker. That cannot finish inside the sub-15s budget a
    // streaming HTTP runtime answers in — forcing the interactive budget on a harness
    // IS the "request timed out after 15 seconds" failure on any real task (build a
    // workflow, author an extension), and it hits EVERY harness, not one vendor. So
    // harnesses get a realistic per-round timeout and a longer multi-round deadline,
    // while streaming runtimes keep the tight budget that protects their latency.
    // Build/extension work streams live canvas events, so the longer harness turn
    // shows continuous progress instead of a frozen spinner. The per-round idle
    // watchdog (HermesAdapter.chat) still bounds each streaming call.
    const forwarding = adapter.capabilities?.().toolForwarding;
    const isCliHarness = forwarding === 'marker_protocol' || forwarding === 'mcp_native';
    const modelRoundTimeoutMs = isCliHarness ? harnessRoundTimeoutMs() : INTERACTIVE_MODEL_ROUND_TIMEOUT_MS;
    const deadlineMs = isCliHarness ? harnessTurnDeadlineMs() : resolveTurnDeadlineMs();
    const adapterMcpNative = forwarding === 'mcp_native';
    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      // Operator disconnected (or the turn was otherwise canceled): stop before
      // starting another model round so we don't keep spending on a turn nobody
      // is listening to. Checked every round, including round 0 (abort during
      // context build). In-flight model/tool work is aborted via ctx.signal too.
      if (ctx.signal?.aborted) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'aborted', timings);
        yield { type: 'done', finishReason: 'error' };
        return;
      }
      // Checked between rounds so an in-flight round is never cut mid-stream.
      if (turn > 0 && Date.now() - options.startedAt > deadlineMs) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'deadline', timings);
        if (!producedText) yield { type: 'text', delta: TURN_DEADLINE_MESSAGE };
        yield { type: 'done', finishReason: 'max_turns' };
        return;
      }
      const toolCalls: ChatToolCall[] = [];
      let assistantText = '';
      let surfacedConfirmation = false;
      let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';

      try {
        yield this.#activity(ctx, 'runtime', 'Waiting for model output', `Runtime pass ${turn + 1} is in progress.`, `runtime-${turn + 1}`);
        timings.rounds += 1;
        const roundStart = Date.now();
        const chatOptions: ChatInvocationOptions = {
          latencyClass: 'interactive',
          timeoutMs: modelRoundTimeoutMs,
          sessionKey: ctx.conversationId,
          ...(adapterMcpNative
            ? { toolMode: options.lightweightConversation ? 'caller_loop' : 'adapter_native' }
            : {}),
          ...(options.preferredModel ? { preferredModel: options.preferredModel } : {}),
        };
        if (ctx.signal) chatOptions.signal = ctx.signal;
        if (retryMaxTokens) chatOptions.maxTokens = retryMaxTokens;
        for await (const delta of adapter.chat!(messages, options.tools, Object.keys(chatOptions).length > 0 ? chatOptions : undefined)) {
          if (delta.type === 'text') {
            assistantText += delta.delta;
            if (delta.delta) producedText = true;
          }
          if (delta.type === 'thinking' && delta.delta) producedThinking = true;
          if ((delta.type === 'text' && delta.delta) || delta.type === 'tool_call') {
            if (timings.firstTokenMs === null) timings.firstTokenMs = Date.now() - options.startedAt;
          }
          if (delta.type === 'tool_call') toolCalls.push({ id: delta.id, name: delta.name, arguments: delta.args });
          if (delta.type === 'confirmation_required') surfacedConfirmation = true;
          if (delta.type === 'done') {
            finishReason = delta.finishReason;
            continue;
          }
          yield delta;
        }
        timings.modelMs += Date.now() - roundStart;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#deps.logger?.warn('chat.turn.adapter_failed', { agentId: ctx.agentId, err: message });
        yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message };
        yield { type: 'done', finishReason: 'error' };
        return;
      }

      if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
        const noOutput = !producedText && !surfacedConfirmation && finishReason !== 'error';
        // Reasoning-only / truncated turn recovery. A reasoning model at high
        // effort can spend its whole output budget thinking and return zero answer
        // text (finish_reason `length`, or a clean `stop` after only `thinking`).
        // Today that surfaces the canned "I didn't produce a reply" and silently
        // discards the model's work — making the orchestrator unusable on
        // follow-ups. Instead, retry ONCE with more room and an explicit nudge to
        // write the final answer. Model-agnostic: no model-family branching, just
        // "give it room + ask plainly", and only when the turn truly produced
        // nothing.
        if (noOutput && !emptyRetryUsed && (finishReason === 'length' || producedThinking)) {
          emptyRetryUsed = true;
          retryMaxTokens = EMPTY_RETRY_MAX_TOKENS;
          this.#deps.logger?.warn('chat.turn.empty_recovered', {
            workspaceId: ctx.workspaceId, agentId: ctx.agentId, conversationId: ctx.conversationId,
            finishReason, producedThinking, round: turn + 1,
          });
          messages.push({ role: 'user', content: REASONING_NUDGE });
          continue;
        }
        this.#logTurn(ctx, options.startedAt, toolCallCount, finishReason, timings);
        // Never finish a turn with nothing on screen. A model that returns no
        // text and no tool call (or an empty single-shot) would otherwise leave
        // the operator staring at a "?" — emit an honest fallback instead. But
        // not when the turn already surfaced a confirmation card (that IS the
        // content) or failed (the route surfaces the adapter error message).
        if (noOutput) {
          // If the model reasoned but still wouldn't answer (even after the retry),
          // say so honestly rather than implying the operator was unclear.
          yield { type: 'text', delta: producedThinking ? REASONED_NO_ANSWER_MESSAGE : EMPTY_TURN_MESSAGE };
        }
        // `length` is not a clean stop — report it as max_turns so the route/UI
        // treats it as a guardrail outcome, not a satisfied answer.
        const terminal = finishReason === 'length' ? 'max_turns' : finishReason;
        yield { type: 'done', finishReason: terminal };
        return;
      }

      messages.push({ role: 'assistant', content: assistantText, toolCalls });

      // Cap batch to remaining budget before kicking off parallel execution.
      const remaining = options.maxToolCalls - toolCallCount;
      const batch = toolCalls.slice(0, remaining);
      if (batch.length < toolCalls.length) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'max_tool_calls', timings);
        if (!producedText) yield { type: 'text', delta: TURN_LIMIT_MESSAGE };
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
          // Don't retain this request's abort signal — the confirmation resumes on
          // a SEPARATE request (see confirm()), which supplies its own signal.
          context: { ...ctx, signal: undefined },
          messages: [...messages.slice(0, -1), assistantForConfirmation],
          tools: options.tools,
          maxTurns: options.maxTurns,
          maxToolCalls: options.maxToolCalls,
          toolCallCount,
          createdAt: now,
          expiresAt: now + CONFIRMATION_TTL_MS,
        });
        yield this.#buildConfirmationDelta(turnId, confirmationCall, now + CONFIRMATION_TTL_MS);
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'confirmation_required', timings);
        yield { type: 'done', finishReason: 'stop' };
        return;
      }

      toolCallCount += batch.length;
      for (const call of batch) {
        yield this.#activity(ctx, 'tool', `Executing ${call.name}`, 'Running an Agentis tool for this turn.', `tool-${call.id}`);
      }

      // Don't kick off tools (some spend model credits — e.g. build_workflow) if
      // the turn was canceled while the model round was streaming.
      if (ctx.signal?.aborted) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'aborted', timings);
        yield { type: 'done', finishReason: 'error' };
        return;
      }
      // If the model is building a workflow this round, give the build a known
      // runId and stream its live narration into the chat (same bridge as the
      // fast-path direct build) so model-driven builds are just as legible.
      const buildCall = batch.find((call) => call.name === 'agentis.build_workflow');
      const buildRunId = buildCall ? (ctx.runId ?? `build_${ctx.clientTurnId ?? randomUUID()}`) : null;
      const execCtx = buildRunId ? { ...ctx, runId: buildRunId } : ctx;
      // Execute all tool calls in parallel — SQLite builtins are sub-ms, HTTP
      // tools can take hundreds of ms. Parallel execution is the spec §6.2 design.
      const toolRoundStart = Date.now();
      const runBatch = () => Promise.all(batch.map((call) => this.#executeToolCall(call, execCtx)));
      let settled: Awaited<ReturnType<typeof runBatch>>;
      if (buildRunId) {
        const holder: { result?: Awaited<ReturnType<typeof runBatch>> } = {};
        yield* this.#streamBuildNarration(execCtx, buildRunId, holder, runBatch);
        settled = holder.result!;
      } else {
        settled = await runBatch();
      }
      timings.toolMs += Date.now() - toolRoundStart;

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

    this.#logTurn(ctx, options.startedAt, toolCallCount, 'max_turns', timings);
    if (!producedText) yield { type: 'text', delta: TURN_LIMIT_MESSAGE };
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

  static async *#executeDirectWorkflowBuild(
    ctx: ChatTurnContext,
    startedAt: number,
    build: { description: string; title?: string; workflowId?: string; mode: 'create' | 'update' },
  ): AsyncIterable<ChatDelta> {
    const runId = `build_${ctx.clientTurnId ?? randomUUID()}`;
    const callId = `build_${randomUUID()}`;
    const timings: TurnTimings = {
      contextMs: 0,
      firstTokenMs: 0,
      modelMs: 0,
      toolMs: 0,
      rounds: 0,
      fastPath: true,
      adapterType: 'agentis_direct',
    };
    const toolCall: ChatToolCall = {
      id: callId,
      name: 'agentis.build_workflow',
      arguments: {
        description: build.description,
        ...(build.title ? { title: build.title } : {}),
        ...(build.workflowId ? { workflowId: build.workflowId } : {}),
      },
    };

    yield {
      type: 'activity',
      id: `activity-${ctx.clientTurnId ?? ctx.conversationId}-workflow-fast-path`,
      phase: 'workflow',
      status: 'running',
      label: build.mode === 'update' ? 'Updating workflow' : 'Building workflow',
      detail: build.mode === 'update'
        ? 'Applying the requested change to the active workflow.'
        : 'Creating the requested workflow.',
      startedAt: new Date().toISOString(),
      agentId: ctx.agentId,
      clientTurnId: ctx.clientTurnId,
      runId,
    };
    yield { type: 'tool_call', id: callId, name: toolCall.name, args: toolCall.arguments };

    const toolStart = Date.now();
    // Run the build and stream its real phase/canvas narration into THIS chat
    // turn as activity deltas — so the operator watches "analyzing → drafting →
    // reviewing → placing nodes → complete" live, in the chat, even if the
    // realtime socket is down. The bus events are published synchronously inside
    // the build, so by the time it settles they are all drained.
    const buildHolder: { result?: Awaited<ReturnType<typeof ChatToolExecutor.run>> } = {};
    yield* this.#streamBuildNarration(ctx, runId, buildHolder, () =>
      ChatToolExecutor.run(toolCall.name, toolCall.arguments, { ...ctx, runId }));
    const result = buildHolder.result!;
    timings.toolMs = Date.now() - toolStart;
    const ok = !result.error;
    recordToolCall(toolCall.name, timings.toolMs, ok);
    yield {
      type: 'tool_result',
      id: callId,
      name: toolCall.name,
      result: result.data ?? null,
      ...(result.error ? { error: result.error } : {}),
    };

    if (result.error) {
      this.#logTurn(ctx, startedAt, 1, 'error', timings);
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    const summary = directBuildSummary(result.data, build.mode);
    if (summary) yield { type: 'text', delta: summary };
    this.#logTurn(ctx, startedAt, 1, 'stop', timings);
    yield { type: 'done', finishReason: 'stop' };
  }

  /**
   * Bridge a workflow build's real backend narration into the chat turn. While
   * `build` is in flight, subscribe to the event bus for THIS run's build/canvas
   * events and yield each as a `phase:'workflow'` activity delta — the same shape
   * the chat already renders in its live execution trace. This makes the build
   * legible from inside the chat itself, independent of the realtime socket (the
   * socket carries the same events for the canvas; this guarantees the chat is
   * never a black box even when the socket is down). Bus events are published
   * synchronously during the build, so the queue is fully drained once it settles.
   */
  static async *#streamBuildNarration<T>(
    ctx: ChatTurnContext,
    runId: string,
    holder: { result?: T },
    run: () => Promise<T>,
  ): AsyncIterable<ChatDelta> {
    const bus = this.#deps.bus;
    if (!bus) { holder.result = await run(); return; }

    const queue: ChatDelta[] = [];
    let wake: (() => void) | null = null;
    const ping = () => { const w = wake; wake = null; w?.(); };
    let settled = false;

    // Subscribe BEFORE starting the build so the first, fast events (e.g. the
    // `analyzing` phase) can never fire before we're listening.
    const unsubscribe = bus.subscribe((msg) => {
      const payload = msg.envelope.payload as Record<string, unknown> | undefined;
      if (!payload || payload.runId !== runId) return;
      const delta = buildNarrationDelta(msg.envelope.event, payload, ctx, runId);
      if (delta) { queue.push(delta); ping(); }
    });
    const build = run();
    void build.then((result) => { holder.result = result; settled = true; ping(); }, () => { settled = true; ping(); });

    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (settled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      while (queue.length > 0) yield queue.shift()!; // flush any final events
    } finally {
      unsubscribe();
    }
    // Surface a rejection to the caller (matches a plain `await run()`).
    if (holder.result === undefined) await build;
  }

  static #activity(
    ctx: ChatTurnContext,
    phase: Extract<ChatDelta, { type: 'activity' }>['phase'],
    label: string,
    detail: string,
    suffix: string,
    status: Extract<ChatDelta, { type: 'activity' }>['status'] = 'running',
  ): Extract<ChatDelta, { type: 'activity' }> {
    return {
      type: 'activity',
      id: `activity-${ctx.clientTurnId ?? ctx.conversationId}-${suffix}`,
      phase,
      status,
      label,
      detail,
      startedAt: new Date().toISOString(),
      agentId: ctx.agentId,
      ...(workflowIdFromViewport(ctx.viewport) ? { workflowId: workflowIdFromViewport(ctx.viewport) } : {}),
      ...(ctx.clientTurnId ? { clientTurnId: ctx.clientTurnId } : {}),
    };
  }

  static #buildConfirmationDelta(turnId: string, call: ChatToolCall, expiresAt: number): Extract<ChatDelta, { type: 'confirmation_required' }> {
    const title = confirmationTitle(call.name);
    const definition = ChatToolExecutor.definition(call.name);
    const impact = confirmationImpact(call.name, call.arguments, definition?.description, this.#deps.db);
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
    const workspace = db
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).get();
    const agent = db
      .select({ name: schema.agents.name, role: schema.agents.role, spaceTag: schema.agents.spaceTag, runtimeModel: schema.agents.runtimeModel })
      .from(schema.agents).where(eq(schema.agents.id, ctx.agentId)).get();
    // PERF: project only the columns we render and push filter/order/limit into
    // SQL. These tables grow without bound (workflow_runs accumulates one row +
    // a full runState/graphSnapshot JSON blob per execution); a prior `.all()`
    // here deserialized EVERY run's state on EVERY chat turn — the cause of the
    // "fast at first, slower over time" degradation. Now O(few), not O(history).
    const agentInventory = db
      .select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, adapterType: schema.agents.adapterType })
      .from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspaceId)).all();
    const activeRuns = db
      .select({ id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, status: schema.workflowRuns.status, createdAt: schema.workflowRuns.createdAt })
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workspaceId, ctx.workspaceId), eq(schema.workflowRuns.status, 'RUNNING')))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(10)
      .all()
      .map((run) => ({ id: run.id, workflowId: run.workflowId ?? `ephemeral:${run.id}`, status: run.status, createdAt: run.createdAt }));
    const pendingApprovals = db
      .select({ id: schema.approvalRequests.id, title: schema.approvalRequests.title, summary: schema.approvalRequests.summary })
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.workspaceId, ctx.workspaceId), eq(schema.approvalRequests.status, 'pending')))
      .orderBy(desc(schema.approvalRequests.createdAt))
      .limit(10)
      .all();
    const gateways = db
      .select({ id: schema.openclawGateways.id, name: schema.openclawGateways.name, status: schema.openclawGateways.status, lastHeartbeatAt: schema.openclawGateways.lastHeartbeatAt })
      .from(schema.openclawGateways).where(eq(schema.openclawGateways.workspaceId, ctx.workspaceId)).all();
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
      agentRole: agent?.role ?? null,
      agentDomain: agent?.spaceTag ?? null,
      agentRuntimeModel: agent?.runtimeModel ?? null,
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
      // PERF: resolve by name in SQL (projected columns) instead of loading the
      // whole agent table (config/capabilityTags JSON) and scanning in JS.
      const row = db
        .select({ id: schema.agents.id, name: schema.agents.name, adapterType: schema.agents.adapterType, status: schema.agents.status, instructions: schema.agents.instructions })
        .from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, ctx.workspaceId), sql`lower(${schema.agents.name}) = ${rawName.toLowerCase()}`))
        .limit(1)
        .get();
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
      // Try run ID first — projected columns + SQL match so we never load the
      // run's runState/graphSnapshot JSON blobs just to resolve a #reference.
      const run = db
        .select({ id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, ephemeralTitle: schema.workflowRuns.ephemeralTitle, status: schema.workflowRuns.status, createdAt: schema.workflowRuns.createdAt })
        .from(schema.workflowRuns)
        .where(and(
          eq(schema.workflowRuns.workspaceId, ctx.workspaceId),
          or(eq(schema.workflowRuns.id, ref), like(schema.workflowRuns.id, `${ref}%`)),
        ))
        .limit(1)
        .get();
      if (run) {
        referencedResources.push({
          kind: 'run',
          id: run.id,
          name: run.workflowId ?? run.ephemeralTitle ?? `ephemeral:${run.id}`,
          detail: `status=${run.status} createdAt=${run.createdAt}`,
        });
        continue;
      }
      // Try workflow by name — project {id,title} only (avoid the graph JSON blob).
      const wf = db
        .select({ id: schema.workflows.id, title: schema.workflows.title })
        .from(schema.workflows)
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

  static #logTurn(
    ctx: ChatTurnContext,
    startedAt: number,
    toolCalls: number,
    finishReason: string,
    timings: TurnTimings,
  ) {
    const totalMs = Date.now() - startedAt;
    this.#deps.logger?.info('chat.turn.completed', {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      finishReason,
      toolCalls,
      durationMs: totalMs,
      // CLB stage breakdown (Phase A): see where the turn actually spent time.
      contextMs: timings.contextMs,
      firstTokenMs: timings.firstTokenMs,
      modelMs: timings.modelMs,
      toolMs: timings.toolMs,
      rounds: timings.rounds,
      fastPath: timings.fastPath,
      adapterType: timings.adapterType,
    });
    recordTurn({
      totalMs,
      contextMs: timings.contextMs,
      firstTokenMs: timings.firstTokenMs,
      modelMs: timings.modelMs,
      toolMs: timings.toolMs,
      toolCalls,
      rounds: timings.rounds,
      finishReason,
      fastPath: timings.fastPath,
      adapterType: timings.adapterType,
    });
  }
}

/** Per-turn stage timers accumulated across rounds (CLB instrumentation). */
interface TurnTimings {
  contextMs: number | null;
  firstTokenMs: number | null;
  modelMs: number;
  toolMs: number;
  rounds: number;
  fastPath: boolean;
  adapterType: string;
}

/**
 * Wall-clock budget (ms) for a whole chat turn before the loop stops and returns
 * a graceful terminal message. Overridable via `AGENTIS_CHAT_TURN_DEADLINE_MS`;
 * non-positive/garbage values fall back to the default so it can't be disabled.
 */
const DEFAULT_TURN_DEADLINE_MS = 45_000;
const INTERACTIVE_MODEL_ROUND_TIMEOUT_MS = 15_000;
// CLI-harness budgets. A harness re-spawns the binary per round, so its rounds
// and whole turns are inherently slower than a streaming runtime's; these are the
// realistic ceilings before a round/turn is fairly called a failure. Generous on
// purpose — and measured: a slow/free harness model (e.g. step-3.7-flash:free)
// takes ~60–115s to FIRST token even for "Hi", and is SILENT on stdio while the
// remote model runs, so any tighter budget guillotines turns that were about to
// answer. A build that streams progress for two minutes beats one that dies at
// 90s. Overridable via env; non-positive/garbage falls back to the default.
const HARNESS_MODEL_ROUND_TIMEOUT_MS = 240_000;
const HARNESS_TURN_DEADLINE_MS = 600_000;
function harnessRoundTimeoutMs(): number {
  const fromEnv = Number(process.env.AGENTIS_HARNESS_ROUND_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return HARNESS_MODEL_ROUND_TIMEOUT_MS;
}
function harnessTurnDeadlineMs(): number {
  const fromEnv = Number(process.env.AGENTIS_HARNESS_TURN_DEADLINE_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return HARNESS_TURN_DEADLINE_MS;
}

/**
 * Max number of dynamic `workflow.<id>` tools advertised per turn. Small on
 * purpose: a large tool list inflates the prompt and slows tool selection on a
 * reasoning model every turn. The viewport's active workflow is always included.
 */
const WORKFLOW_TOOL_CAP = 12;
function resolveTurnDeadlineMs(): number {
  const fromEnv = Number(process.env.AGENTIS_CHAT_TURN_DEADLINE_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TURN_DEADLINE_MS;
}

function parseDirectWorkflowMutationIntent(
  message: string,
  viewport: ViewportContext | null | undefined,
): { description: string; title?: string; workflowId?: string; mode: 'create' | 'update' } | null {
  const text = message.trim();
  if (text.length < 8) return null;
  const lower = text.toLowerCase();
  // Command routing is based on action + active resource, not a specific use
  // case. Explanatory/meta requests stay in ordinary chat.
  if (/\b(explain|why|how does|what is|compare|design doc|architecture)\b/.test(lower)) return null;
  // Capability-authoring requests may require multiple ordered tools
  // (create extension/ability, then build the workflow). Do not collapse them
  // into the single build_workflow fast path.
  if (
    /\b(ability|abilities|extension|extensions|plugin|plugins|connector|listener source|persistent listener)\b/.test(lower)
    && /\b(create|build|make|generate|add|new|update|revise|modify|change|edit|fix|repair|replace|reconfigure|configure|convert|migrate|set|use|wire|attach)\b/.test(lower)
  ) return null;
  const namesWorkflow = /\b(workflow|automation|flow|agentis app)\b/.test(lower);
  const createAction = /\b(build|create|make|generate|set up|setup)\b/.test(lower);
  const mutateAction = /\b(update|revise|modify|change|edit|fix|repair|improve|extend|add|remove|replace|reconfigure|configure|convert|migrate)\b/.test(lower);
  const activeWorkflowId = workflowIdFromViewport(viewport);

  if (mutateAction && activeWorkflowId && (namesWorkflow || refersToActiveResource(lower))) {
    return { description: text, workflowId: activeWorkflowId, mode: 'update' };
  }
  if (createAction && namesWorkflow) {
    const title = titleFromDirectBuild(text);
    return { description: text, ...(title ? { title } : {}), mode: 'create' };
  }
  return null;
}

function refersToActiveResource(text: string): boolean {
  return /\b(this|the current|current|active|it)\b/.test(text);
}

function titleFromDirectBuild(text: string): string | undefined {
  const withoutPrefix = text
    .replace(/^\s*(please\s+)?(build|create|make|generate|set up|setup)\s+(a|an|the)?\s*(workflow|automation|flow|agentis app)?\s*(that|to|for)?\s*/i, '')
    .trim();
  const firstLine = (withoutPrefix || text).split(/\r?\n/)[0]!.replace(/\s+/g, ' ').trim();
  if (!firstLine) return undefined;
  const clipped = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
  return clipped.replace(/^\w/, (c) => c.toUpperCase());
}

function directBuildSummary(result: unknown, mode: 'create' | 'update' = 'create'): string {
  if (!result || typeof result !== 'object') {
    return mode === 'update' ? 'Workflow updated.' : 'Workflow built.';
  }
  const r = result as {
    title?: unknown;
    workflowId?: unknown;
    nodeCount?: unknown;
    edgeCount?: unknown;
    deliveryPreview?: Array<{ summary?: string }>;
    approvalRequired?: unknown;
    warnings?: unknown[];
  };
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : 'Workflow';
  const nodes = typeof r.nodeCount === 'number' ? `${r.nodeCount} nodes` : 'built';
  const delivery = Array.isArray(r.deliveryPreview) && r.deliveryPreview.length > 0
    ? ` Delivers to: ${r.deliveryPreview.map((d) => d.summary).filter(Boolean).join('; ')}.`
    : '';
  const approval = r.approvalRequired === true ? ' Approval required before delivery.' : '';
  const warnings = Array.isArray(r.warnings) && r.warnings.length > 0
    ? ` ${r.warnings.length} setup item${r.warnings.length === 1 ? '' : 's'} need attention.`
    : '';
  const verb = mode === 'update' ? 'Updated' : 'Built';
  return `${verb} "${title}" with ${nodes}.${delivery}${approval}${warnings}`;
}

/** Human labels for the build's WORKFLOW_BUILD_PHASE stages. */
const BUILD_PHASE_LABEL: Record<string, string> = {
  analyzing: 'Analyzing your request',
  drafting: 'Drafting the workflow graph',
  repairing: 'Repairing the graph structure',
  reviewing: 'Reviewing against the workflow rules',
  building: 'Assembling the workflow',
  complete: 'Build complete',
  blocked: 'Build blocked',
};

/**
 * Map one build/canvas bus event onto a chat `activity` delta (phase 'workflow',
 * which the chat renders in its live trace), or null to ignore it. Kept minimal
 * on purpose — phase milestones, the cast roster, each node as it lands, and the
 * final summary — so the chat reads like plain-language progress, not a firehose.
 */
function buildNarrationDelta(
  event: string,
  payload: Record<string, unknown>,
  ctx: ChatTurnContext,
  runId: string,
): Extract<ChatDelta, { type: 'activity' }> | null {
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : undefined;
  const mk = (
    suffix: string,
    label: string,
    detail: string | undefined,
    status: Extract<ChatDelta, { type: 'activity' }>['status'] = 'running',
  ): Extract<ChatDelta, { type: 'activity' }> => ({
    type: 'activity',
    id: `build-${runId}-${suffix}`,
    phase: 'workflow',
    status,
    label,
    ...(detail ? { detail } : {}),
    startedAt: new Date().toISOString(),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.clientTurnId ? { clientTurnId: ctx.clientTurnId } : {}),
    ...(workflowId ? { workflowId } : {}),
    runId,
  });

  switch (event) {
    case REALTIME_EVENTS.WORKFLOW_BUILD_PHASE: {
      const phaseName = typeof payload.phase === 'string' ? payload.phase : 'building';
      const label = BUILD_PHASE_LABEL[phaseName] ?? `Build: ${phaseName}`;
      const detail = typeof payload.detail === 'string' ? payload.detail : undefined;
      const status = phaseName === 'complete' ? 'success' : phaseName === 'blocked' ? 'error' : 'running';
      // One row per phase name so repeated emissions of the same phase update in place.
      return mk(`phase-${phaseName}`, label, detail, status);
    }
    case REALTIME_EVENTS.WORKFLOW_TEAM_ROSTER: {
      const roster = Array.isArray(payload.roster) ? payload.roster : [];
      if (roster.length === 0) return null;
      return mk('roster', `Casting ${roster.length} specialist${roster.length === 1 ? '' : 's'}`, undefined);
    }
    case REALTIME_EVENTS.CANVAS_NODE_PLACED: {
      const node = (payload.node ?? {}) as { id?: unknown };
      const nodeId = node.id ? String(node.id) : randomUUID();
      const nodeLabel = typeof payload.nodeLabel === 'string' ? payload.nodeLabel : 'a step';
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
      return mk(`node-${nodeId}`, `Placed ${nodeLabel}`, reason);
    }
    case REALTIME_EVENTS.CANVAS_BUILD_COMPLETE: {
      const n = typeof payload.nodeCount === 'number' ? payload.nodeCount : undefined;
      const e = typeof payload.edgeCount === 'number' ? payload.edgeCount : undefined;
      const detail = n !== undefined
        ? `${n} node${n === 1 ? '' : 's'}${e !== undefined ? `, ${e} connection${e === 1 ? '' : 's'}` : ''}`
        : undefined;
      return mk('complete', 'Workflow ready', detail, 'success');
    }
    default:
      return null;
  }
}

/**
 * Per-builder time budget (ms) for the concurrent context retrievers. A builder
 * that exceeds it is dropped from this turn (it keeps running but its result is
 * ignored), so a slow retriever degrades gracefully instead of blocking output.
 */
const CONTEXT_BUILDER_BUDGET_MS = 1200;

/**
 * Resolve `factory()` but never wait longer than `ms` and never reject: on
 * timeout (and on any rejection) resolve with `fallback`. Used to time-box the
 * best-effort context retrievers so one slow dependency can't stall a chat turn.
 */
function withBudget<T>(factory: () => Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      resolve(fallback);
    }, ms);
    timer.unref?.();
    factory().then(finish, () => finish(fallback));
  });
}

/**
 * Whether a message carries enough of a query signal to justify a knowledge-base
 * embedding search. This gates retrieval on information content — not a phrase
 * whitelist — so trivial chatter ("hi", "ok", "?") skips the network round-trip
 * while any substantive request still retrieves.
 */
function hasRetrievalSignal(message: string): boolean {
  const text = message.trim();
  if (text.length < 6) return false;
  const tokens = text.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (tokens.length >= 2) return true;
  return tokens.some((token) => token.length >= 6);
}

/**
 * A deliberately narrow set of turns that can be answered without workspace
 * tools or remote memory enrichment. Full-string matching prevents action
 * requests such as "Hi, build a workflow" from accidentally taking this path.
 */
function isLightweightConversation(message: string): boolean {
  const text = message.trim().toLowerCase().replace(/[!.?]+$/g, '').trim();
  return /^(?:hi|hello|hey|hiya|howdy|good (?:morning|afternoon|evening)|thanks|thank you|thx|ok|okay|got it|who are you|what are you|how are you)$/.test(text);
}

/** Honest terminal messages for turns that hit a guardrail instead of a clean stop. */
const TURN_DEADLINE_MESSAGE =
  'I ran out of time on this turn before I could finish, so I stopped here rather than leave you waiting. Tell me to continue and I’ll pick it back up — or narrow the request and I’ll be faster.';
const TURN_LIMIT_MESSAGE =
  'I worked through several steps but reached the per-turn action limit before finishing. Tell me to continue and I’ll keep going from where I left off.';
const EMPTY_TURN_MESSAGE =
  'The runtime completed without returning an answer. I stopped the turn so you can retry without wondering whether it is still running.';
/** Shown when the model reasoned but never surfaced an answer, even after the
 *  recovery retry — honest about what happened instead of blaming the operator. */
const REASONED_NO_ANSWER_MESSAGE =
  'I worked through that but didn’t manage to put my answer into words before running out of room. Tell me to continue and I’ll write it out — or narrow the ask and I’ll be more direct.';
/** Appended on the one-shot recovery pass to coax a reasoning-only turn into
 *  emitting its final answer as normal reply text (and any needed tool calls). */
const REASONING_NUDGE =
  'Write your final answer now as a normal reply, and call any tools you need. Do not return empty content.';
/** Bumped output budget for the recovery retry, so a reasoning model has room to
 *  emit the answer after the original pass exhausted its budget thinking. */
const EMPTY_RETRY_MAX_TOKENS = 16_000;

/**
 * Per-block char budgets for injected context that grows with workspace state.
 * Sum (~12.5KB ≈ ~3K tokens) is the constant ceiling added per turn regardless
 * of how much memory/brain/knowledge has accumulated.
 */
const CONTEXT_BUDGET = {
  agentMemory: 2500,
  personalBrain: 2000,
  workspaceContext: 3500,
  situationalModel: 2500,
  brainInjection: 2000,
} as const;

/** Truncate an injected context block to a fixed budget so prompt size stays constant. */
function clampBlock(text: string | null, maxChars: number): string | null {
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n…(truncated to keep context size constant)`;
}

function trimHistory(history: ChatMessage[]): ChatMessage[] {
  return history
    .filter((message) => message.role !== 'system')
    .slice(-40);
}

function countUserTurns(history: ChatMessage[]): number {
  return history.filter((message) => message.role === 'user').length;
}

function historyMessageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => block.text ?? block.content ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

function workflowIdFromViewport(viewport: ViewportContext | null | undefined): string | undefined {
  if (!viewport) return undefined;
  if (viewport.resourceKind === 'workflow' && viewport.resourceId) return viewport.resourceId;
  if (typeof viewport.metadata?.workflowId === 'string') return viewport.metadata.workflowId;
  return undefined;
}

function expandUserMessage(message: string): string {
  if (!message.startsWith('/')) return message;
  const match = message.match(/^\/(\w+)\s*(.*)$/);
  if (!match) return message;
  const [, command, rest = ''] = match;
  const mapping: Record<string, string> = {
    run: `The operator used /run. Resolve the workflow they mean, then use agentis.workflow.run when safe. Request missing IDs instead of guessing. Request: ${rest}`,
    approve: `The operator used /approve. List pending approvals, identify the intended approval, and only resolve it if the instruction is explicit. Request: ${rest}`,
    approvals: `The operator used /approvals. List the pending approvals with their ids and summaries using tools, then ask which to approve or reject. Request: ${rest}`,
    status: `The operator used /status. Summarize current runs, agents, gateways, and approvals using tools. Request: ${rest}`,
    agents: `The operator used /agents. List the workspace agents — name, role, status, and what each is for — using tools. Request: ${rest}`,
    runs: `The operator used /runs. Summarize the active and most recent workflow runs with their status using tools. Request: ${rest}`,
    stop: `The operator used /stop. Identify the most recent active run and, only after confirming, cancel it with agentis.run.cancel. Request: ${rest}`,
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

function confirmationTitle(toolName: string): string {
  const titles: Record<string, string> = {
    'agentis.workflow.run': 'Run workflow?',
    'agentis.run.cancel': 'Cancel run?',
    'agentis.approval.resolve': 'Resolve approval?',
    'agentis.ephemeral.run': 'Run ephemeral workflow?',
  };
  return titles[toolName] ?? 'Confirm platform action?';
}

function confirmationConfirmLabel(toolName: string): string {
  const labels: Record<string, string> = {
    'agentis.workflow.run': 'Run workflow',
    'agentis.run.cancel': 'Cancel run',
    'agentis.approval.resolve': 'Resolve approval',
    'agentis.ephemeral.run': 'Run once',
  };
  return labels[toolName] ?? 'Confirm';
}

function confirmationImpact(toolName: string, args: unknown, fallbackDescription?: string, db?: AgentisSqliteDb): {
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

  if (toolName === 'agentis.memory.delete') {
    const id = record.id ? String(record.id) : null;
    let memoryTitle = 'Unknown memory';
    let memoryContent = '';
    if (id && db) {
      try {
        const mem = db.select().from(schema.workspaceMemory).where(eq(schema.workspaceMemory.id, id)).get();
        if (mem) {
          memoryTitle = mem.title;
          memoryContent = mem.content;
        }
      } catch (err) {
        // ignore db error
      }
    }
    return {
      summary: `Delete memory entry: "${memoryTitle}"`,
      details: [
        `Memory ID: ${id}`,
        ...(memoryContent ? [`Content: "${memoryContent.length > 100 ? memoryContent.slice(0, 100) + '...' : memoryContent}"`] : []),
      ],
      riskLevel: 'medium',
      reversible: false,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.memory.write') {
    const title = stringFrom(record.title) ?? 'Untitled memory';
    const content = stringFrom(record.content) ?? '';
    const kind = stringFrom(record.kind) ?? 'fact';
    return {
      summary: `Create workspace memory: "${title}"`,
      details: [
        `Kind: ${kind}`,
        ...(content ? [`Content: "${content.length > 100 ? content.slice(0, 100) + '...' : content}"`] : []),
      ],
      riskLevel: 'low',
      reversible: true,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.knowledge.archive') {
    const documentId = record.documentId ? String(record.documentId) : null;
    let docName = 'Unknown document';
    if (documentId && db) {
      try {
        const doc = db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, documentId)).get();
        if (doc) {
          docName = doc.name;
        }
      } catch (err) {
        // ignore db error
      }
    }
    return {
      summary: `Archive knowledge document: "${docName}"`,
      details: [
        `Document ID: ${documentId}`,
      ],
      riskLevel: 'medium',
      reversible: true,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.knowledge.write') {
    const name = stringFrom(record.name) ?? 'Untitled document';
    return {
      summary: `Upload/write knowledge document: "${name}"`,
      details: [
        `Mime Type: ${stringFrom(record.mimeType) ?? 'text/plain'}`,
      ],
      riskLevel: 'low',
      reversible: true,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.workflow.run' || toolName.startsWith('workflow.')) {
    return {
      summary: 'This will start a real workflow run in the current workspace.',
      details: [
        ...details,
        'The workflow may execute agents, extensions, integrations, or checkpoints depending on its graph.',
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
