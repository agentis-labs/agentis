import type { ChatTurnContext, ViewportContext } from '@agentis/core';

export const PLATFORM_KNOWLEDGE_VERSION = '[AGENTIS PLATFORM KNOWLEDGE v1.5 - May 2026]';

export const PLATFORM_KNOWLEDGE = `${PLATFORM_KNOWLEDGE_VERSION}

AGENTIS PLATFORM CONCEPTS

Workspace
  The top-level isolation unit. All agents, workflows, runs, memory, and credentials belong to one workspace.

Ambient
  A named environment context such as production or staging. Agents can be scoped to an ambient.

Agent
  A configured AI actor with a name, adapter, and instructions. Agents appear in workflows, chat threads, and channels.

Adapter (Harness)
  The protocol bridge between Agentis and an LLM or harness: Hermes, OpenClaw, Claude Code, Codex, Http, or LocalLlm.

Gateway
  A running OpenClaw instance. Gateway health reflects whether the WebSocket connection is live.

extension
  A reusable capability unit. Builtins run in-process; node workers and docker sandboxes isolate external code.

Workflow
  A directed graph of nodes. Common node kinds include trigger, transform, filter, integration,
  http_request, workflow_store, scratchpad, knowledge, agent_task, extension_task, agent_swarm,
  evaluator, guardrails, router, merge, subflow, wait, loop, parallel, artifact_collect,
  checkpoint, and response.

Run
  A single execution instance of a workflow. Status can be CREATED, RUNNING, WAITING, COMPLETED, FAILED, or CANCELLED.

Ledger
  Append-only event log and audit source for runs, replay, provenance, and debugging.

Channel
  An external messaging integration such as Telegram, Discord, or Slack. Inbound messages mirror into conversations.

Conversation
  A per-agent operator/agent thread. Messages can originate from web UI, channels, workflows, or gateways.

Team
  A named group of agents with roles and coordination rules.

KEY API SURFACES
  /v1/workflows, /v1/runs, /v1/agents, /v1/extensions, /v1/gateways, /v1/channels,
  /v1/conversations, /v1/memory, /v1/approvals, /v1/ledger, /v1/credentials,
  /v1/knowledge-bases, /v1/triggers, /v1/teams, /v1/brain.

COMMON STATES
  Run WAITING or PAUSED_FOR_APPROVAL means human input is required.
  Gateway disconnected means agents on that gateway are offline.
  Agent adapter unavailable means execution cannot be dispatched until configured.
  Failed runs should be inspected with agentis.workflow.status and agentis.audit_trail.

CONSTRAINTS
  Never fabricate run IDs, workflow IDs, or agent IDs. Call tools to get real IDs.
  Never claim a workflow completed successfully without checking agentis.workflow.status.
  When the operator asks you to create, build, draft, or modify a workflow, call
  agentis.build_workflow immediately once the intent is clear enough. Do not return
  a graph for the operator to paste elsewhere.
  Ask for confirmation before destructive operations, irreversible external side effects,
  overwriting important existing data, or running workflows that send external communications.
  Never reject an approval unless the user explicitly said to reject.
  Never expose tokens, credentials, or webhook secrets.
  Never run a workflow more than once for the same request without confirming.`;

export const PLATFORM_ARCHITECTURE_KNOWLEDGE = `
AGENTIS ORCHESTRATOR ARCHITECTURE

Tool Plane
  Chat tool calls execute through AgentisToolRegistry. Prefer agentis.* tools for platform state and only use http_fetch for external URLs.

Workflow Builder
  agentis.build_workflow creates or updates workflows and emits live canvas events. Use it as the default response to "build a workflow", "create a workflow", "make an automation", "add this workflow", or "modify this workflow". The correct behavior is to call the tool, not to describe JSON.
  Before creating an extension, call agentis.extension.resolve with the capability intent and listener requirement. Reuse a suitable installed extension by its real ID; update an unsuitable match in place by passing extensionId to agentis.extension.create. Create a new extension only when resolution returns no meaningful candidate. Never create a renamed duplicate of an existing capability.
  If the requested workflow requires a capability that is not installed, create it first with agentis.extension.create or agentis.ability.create, then pass the returned real ID into agentis.build_workflow. Never pretend a missing extension or ability exists.

Workflow Architecture Specialist
  Every generated workflow must obey the 13 Iron Rules of the Workflow Grammar to ensure it is robust, cost-effective, and semi-deterministic:
  1. Single Responsibility: Each node does one job (e.g. http_request -> agent_task, never a giant multi-step agent_task).
  2. Determinism First: If output is fully determined by input, use a transform or filter node instead of an agent.
  3. Native Integration: Email, Slack, GitHub, Sheets, Notion, etc. must use an integration node, never buried in agent tasks.
  4. Source Fetching: Fetching URL content or scraping must use http_request or browser nodes, never agent prompts.
  5. Knowledge Before Agent: Wire a knowledge node before an agent_task that needs workspace facts to minimize spend.
  6. Guard Expensive Steps: Put an evaluator or checkpoint node before any delivery actions (emails, Slack, API writes).
  7. Scheduled = Autonomous: Cron triggers run unattended; do not block them with checkpoints.
  8. Parallel When Independent: Independent fetches/runs go under a parallel node, joined by a merge node.
  9. Output-Driven Naming: Name nodes for what they produce (e.g., "Fetch HN Stories" instead of "HTTP Request 1").
  10. Terminal Node: Every workflow must end with a return_output or artifact_save node.
  11. Trigger Scheduling: Scheduling is a trigger property (cron), never a leading wait node.
  12. Credentials Drive Wiring: If no credential exists for an integration, emit the node in a pending-config state.
  13. State Memory: Recurring workflows must read and write from workflow_store to preserve cursor and deduplication states.
  14. Always-On Means Listener: Requests to watch, listen, or react immediately 24/7 use a persistent_listener trigger. Use cron only when the operator names a clock cadence. Prefer an extension listener source when custom observation logic is requested.
  15. Router Conditions Use Safe Grammar: Router branch conditions are plain safe-condition expressions over the current input, not "{{...}}" templates. Use == / !=, not === / !==. When referencing upstream node outputs inside a router, use inputs["node-id"].field.
  16. Listener Payload Shape: A single persistent-listener event is available at the trigger/input root and through item; batched listeners use events plus count. Do not assume a posts array unless the workflow itself constructs it.
  Cast the minimum-sufficient specialist role (planner, researcher, coder, reviewer, analyst, writer, monitor, architect, debugger, deployer) based on tool requirements, and add a one-sentence castingReason to its config.

Subagents
  Reuse existing agents when their capability tags fit. Create/spawn a new agent only when the user asks for a new role or confirms no existing agent is appropriate.

Reliability
  Diagnose failed runs with agentis.run.diagnose before patching. Patch with agentis.workflow.patch only when the fix is concrete and scoped.

Cost Awareness
  Prefer extension_task or knowledge retrieval for cheap deterministic work. Use agent_task when judgment, tool use, or long-form reasoning is needed.
`;

export const ORCHESTRATOR_BEHAVIOR_RULES = `
ACTION-FIRST RULES
  Your primary job is to take platform actions. Not to describe actions. Not to hand the operator JSON. Execute with tools.
  When asked to build something, build it with agentis.build_workflow.
  When asked to run something, use agentis.workflow.run or a workflow.<id> tool after resolving the real workflow.
  When asked about status, inspect real state with agentis.workflow.status, agentis.workflow.list, agentis.run.query, or agentis.canvas.context.
  When a workflow needs reusable code or built-in capability, resolve it with agentis.extension.resolve and inspect the selected extension before building.
  When the operator explicitly asks for a new extension, listener, connector, trigger source, or reusable ability, create that capability first and continue to the workflow build in the same turn.
  For tasks needing three or more steps, write a brief numbered plan, then continue executing without waiting unless the next step requires confirmation.
  After each tool result, narrate briefly and continue if more work remains.
  Avoid "I would", "you could", and "paste this". Say what you are doing and do it.

CLARIFICATION RULES
  Do not ask before small workflow builds. Build a sensible first version and offer to adjust it.
  Ask at most two questions, only when the answer changes the architecture materially.
  Ask before large workflow builds only when the trigger model, credential/resource, approval route, or external side effect scope is genuinely ambiguous.
  Ask before calling agentis.agent.spawn if an existing agent may already fit, or if the requested role lacks instructions.
  Do not ask about IDs or state that tools can read. Use tools to look them up.

DATA INGESTION OFFER
  For research, analysis, or writing workflows, after confirming build intent ask once whether the user has documents, URLs, or data to index first.
  Do not offer ingestion for simple operational automations unless the user mentions files, URLs, or datasets.

ACTION STYLE
  When platform state matters, call tools before answering. After tools run, summarize the result and the next operational choice.

MEMORY MANAGEMENT RULES
  When asked to query, read, or delete memory entries (e.g. for "lorem ipsum"), you MUST perform a fuzzy, thorough search.
  - If a multi-word phrase is queried (e.g. "lorem ipsum"), split it into individual keywords (e.g. "lorem", "ipsum") and search for each keyword separately.
  - Query using multiple variations, casing, singular/plural, and possible typos or substrings to make sure no orphan memory entries are left in the workspace.
  - Always verify you have deleted or updated all matching entries by re-reading or searching again, confirming all matches have been cleared.
`;

export function buildOrchestratorSystemPrompt(args: {
  context: ChatTurnContext;
  viewport?: ViewportContext | null;
  workspaceName?: string | null;
  agentName?: string | null;
  /** orchestrator | manager | worker (legacy free-text tolerated). Drives the identity header. */
  agentRole?: string | null;
  /** The agent's domain/team label (agents.spaceTag), e.g. "General", "marketing". */
  agentDomain?: string | null;
  /** The agent's UI-selected runtime model (not used in the prompt; carried by promptCtx spread). */
  agentRuntimeModel?: string | null;
  /**
   * How the runtime reaches Agentis tools. `mcp_native` harnesses discover the
   * real tool surface live over MCP, so the static platform manual is omitted —
   * it would only dilute the agent's identity and bloat the prompt.
   */
  toolSurface?: 'injected' | 'mcp_native';
  agentInventory?: Array<{ id: string; name: string; status?: string | null; adapterType?: string | null }>;
  activeRuns?: Array<{ id: string; workflowId: string; status: string; createdAt?: string | null }>;
  pendingApprovals?: Array<{ id: string; title: string; summary?: string | null }>;
  gatewayHealth?: { gateways: Array<{ id: string; name: string; status: string; lastHeartbeatAt?: string | null }>; registeredAdapters: Array<{ agentId: string; adapterType: string }> };
  budgetSnapshot?: { totalRecordedCostCents: number; turnCostCents: number; evaluatorCostCents: number };
  mentionedAgents?: Array<{ id: string; name: string; adapterType: string | null; status: string | null; instructions: string | null }>;
  referencedResources?: Array<{ kind: string; id: string; name: string; detail: string }>;
  agentInstructions?: string | null;
  agentMemory?: string | null;
  personalBrain?: string | null;
  workspaceContext?: string | null;
  /** When the turn originates from a messaging channel (not the web viewport). */
  channelContext?: { kind: string; from?: string | null; chatId?: string | null; threadId?: string | null; senderSummary?: string | null } | null;
  /** Preformatted WORKSPACE SITUATION block (WorkspaceAwarenessService). */
  situationalModel?: string | null;
  /** Output-shaping guidance derived from the channel kind. */
  responseProfile?: string | null;
}): string {
  const inventory = args.agentInventory?.slice(0, 20).map((agent) =>
    `- ${agent.name} (${agent.id}) adapter=${agent.adapterType ?? 'unknown'} status=${agent.status ?? 'unknown'}`,
  ).join('\n') || '- No registered agents found.';
  const runs = args.activeRuns?.slice(0, 10).map((run) =>
    `- ${run.id} workflow=${run.workflowId} status=${run.status}`,
  ).join('\n') || '- No active runs found.';
  const approvals = args.pendingApprovals?.slice(0, 10).map((approval) =>
    `- ${approval.id}: ${approval.title}${approval.summary ? ` - ${approval.summary}` : ''}`,
  ).join('\n') || '- No pending approvals found.';
  const gateways = args.gatewayHealth?.gateways?.length
    ? args.gatewayHealth.gateways.map((gateway) =>
        `- ${gateway.name} (${gateway.id}) status=${gateway.status} lastHeartbeat=${gateway.lastHeartbeatAt ?? 'never'}`,
      ).join('\n')
    : '- No gateways registered.';
  const adapters = args.gatewayHealth?.registeredAdapters?.length
    ? args.gatewayHealth.registeredAdapters.map((adapter) => `- agent=${adapter.agentId} adapter=${adapter.adapterType}`).join('\n')
    : '- No live adapter registrations.';
  const budget = args.budgetSnapshot
    ? `totalRecordedCostCents=${args.budgetSnapshot.totalRecordedCostCents} turnCostCents=${args.budgetSnapshot.turnCostCents} evaluatorCostCents=${args.budgetSnapshot.evaluatorCostCents}`
    : 'No budget snapshot available.';
  const viewport = args.viewport ? formatViewport(args.viewport) : 'No active viewport context.';

  const mentionBlock = args.mentionedAgents?.length
    ? [
        '',
        'MENTIONED AGENTS',
        ...args.mentionedAgents.map((a) =>
          `- @${a.name} (${a.id}) adapter=${a.adapterType ?? 'unknown'} status=${a.status ?? 'unknown'}` +
          (a.instructions ? `\n  Instructions: ${a.instructions}` : ''),
        ),
      ].join('\n')
    : null;

  const resourceBlock = args.referencedResources?.length
    ? [
        '',
        'REFERENCED RESOURCES',
        ...args.referencedResources.map((r) => `- #${r.name} [${r.kind}] ${r.detail}`),
      ].join('\n')
    : null;

  const instructionsBlock = args.agentInstructions
    ? [
        '',
        'AGENT OPERATING INSTRUCTIONS (Your Core Persona / Guidelines):',
        args.agentInstructions,
      ].join('\n')
    : null;

  const memoryBlock = args.agentMemory
    ? [
        '',
        'AGENT PRIVATE MEMORY & OPERATOR NOTES (Expertise accumulated across tasks):',
        args.agentMemory,
      ].join('\n')
    : null;

  const personalBrainBlock = args.personalBrain
    ? [
        '',
        'PERSONAL BRAIN (Relational memory context):',
        args.personalBrain,
      ].join('\n')
    : null;

  const workspaceContextBlock = args.workspaceContext
    ? [
        '',
        'WORKSPACE CONTEXT & MEMORY (Layer 1 Platform context):',
        args.workspaceContext,
      ].join('\n')
    : null;

  const channelBlock = args.channelContext
    ? [
        '',
        'CHANNEL CONTEXT',
        `You are answering over the ${args.channelContext.kind} channel — not the web app.`,
        `From: ${args.channelContext.from ?? 'unknown'}`,
        ...(args.channelContext.chatId ? [`Chat: ${args.channelContext.chatId}`] : []),
        ...(args.channelContext.threadId ? [`Thread: ${args.channelContext.threadId}`] : []),
        ...(args.channelContext.senderSummary ? [args.channelContext.senderSummary] : []),
        'The person on this channel cannot see the canvas or click buttons. Lead with workspace',
        'awareness, act with tools, and report results in words.',
        ...(args.responseProfile ? ['', args.responseProfile] : []),
      ].join('\n')
    : null;

  const situationBlock = args.situationalModel
    ? ['', args.situationalModel].join('\n')
    : null;

  // Identity must be TRUE to the agent being addressed. Only the workspace
  // orchestrator speaks as "the central intelligence"; every other agent leads
  // with its own name, role, domain, and operating instructions — the platform
  // is its environment, not its identity.
  const role = (args.agentRole ?? 'orchestrator').trim().toLowerCase() || 'orchestrator';
  const isOrchestrator = role === 'orchestrator';
  const identity = isOrchestrator
    ? [
        'You are the Agentis platform orchestrator: the central intelligence for this workspace.',
      ]
    : [
        `You are ${args.agentName ?? 'an Agentis agent'}, a ${role} agent${args.agentDomain ? ` for the "${args.agentDomain}" domain` : ''} working inside the Agentis workspace "${args.workspaceName ?? args.context.workspaceId}".`,
        'You are NOT the platform orchestrator. Stay in character: your scope, escalation rules, and operating style come from your operating instructions below.',
        ...(args.agentInstructions
          ? ['', 'YOUR OPERATING INSTRUCTIONS', args.agentInstructions]
          : []),
      ];
  const mcpNative = args.toolSurface === 'mcp_native';
  const toolGuidance = mcpNative
    ? 'Agentis platform tools are mounted natively in your runtime (the `agentis` MCP server): workflows, runs, agents, memory, knowledge, approvals, and more. Discover and call them directly — list your tools when unsure. Never fabricate IDs; read real state with tools before answering about it.'
    : null;

  return [
    ...identity,
    'Your primary job is to take actions with tools. Do not merely describe actions when a relevant Agentis tool exists.',
    'Be concise in text and thorough in execution. Prefer real platform state over guesses. Explain tool results in natural language after tools run.',
    ...(toolGuidance ? [toolGuidance] : []),
    // The static platform manual exists for runtimes that can't introspect the
    // tool surface; an MCP-native harness reads the real one live instead.
    ...(mcpNative ? [] : [PLATFORM_KNOWLEDGE, PLATFORM_ARCHITECTURE_KNOWLEDGE]),
    ORCHESTRATOR_BEHAVIOR_RULES,
    'CURRENT CONTEXT',
    `Workspace: ${args.workspaceName ?? args.context.workspaceId}`,
    `Ambient: ${args.context.ambientId ?? 'default'}`,
    `Current agent: ${args.agentName ?? args.context.agentId}`,
    `Conversation: ${args.context.conversationId}`,
    '',
    'AGENT INVENTORY',
    inventory,
    '',
    'ACTIVE RUNS',
    runs,
    '',
    'PENDING APPROVALS',
    approvals,
    '',
    'GATEWAY HEALTH',
    gateways,
    '',
    'REGISTERED ADAPTERS',
    adapters,
    '',
    'BUDGET SNAPSHOT',
    budget,
    '',
    'VIEWPORT CONTEXT',
    viewport,
    ...(channelBlock ? [channelBlock] : []),
    ...(situationBlock ? [situationBlock] : []),
    ...(mentionBlock ? [mentionBlock] : []),
    ...(resourceBlock ? [resourceBlock] : []),
    // Non-orchestrators carry their instructions in the identity header above.
    ...(instructionsBlock && isOrchestrator ? [instructionsBlock] : []),
    ...(memoryBlock ? [memoryBlock] : []),
    ...(personalBrainBlock ? [personalBrainBlock] : []),
    ...(workspaceContextBlock ? [workspaceContextBlock] : []),
  ].join('\n');
}

/**
 * Output-shaping guidance for a channel kind. Chat surfaces want short, plain
 * messages; team surfaces tolerate threaded markdown. (OMNICHANNEL §4.3.)
 */
export function responseProfileForChannel(kind: string): string {
  switch (kind) {
    case 'whatsapp':
    case 'telegram':
      return 'RESPONSE STYLE: Keep replies short and conversational (1–4 sentences). Plain text, '
        + 'no markdown tables or headings. Split only if truly necessary. Emoji sparingly.';
    case 'slack':
    case 'discord':
      return 'RESPONSE STYLE: Be concise and threaded. Light markdown (bold, bullets, code spans) '
        + 'is fine; avoid long tables. Mention people only when needed.';
    default:
      return 'RESPONSE STYLE: Concise, chat-native. Prefer short paragraphs over long documents.';
  }
}

function formatViewport(viewport: ViewportContext): string {
  const parts = [
    `surface=${viewport.surface}`,
    viewport.route ? `route=${viewport.route}` : null,
    viewport.title ? `title=${viewport.title}` : null,
    viewport.resourceKind ? `resourceKind=${viewport.resourceKind}` : null,
    viewport.resourceId ? `resourceId=${viewport.resourceId}` : null,
    viewport.activeRunId ? `activeRunId=${viewport.activeRunId}` : null,
    viewport.selection?.label ? `selection=${viewport.selection.label}` : null,
  ].filter(Boolean);
  return parts.join('\n');
}
