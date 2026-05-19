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

Skill
  A reusable capability unit. Builtins run in-process; node workers and docker sandboxes isolate external code.

Workflow
  A directed graph of nodes. Common node types include trigger, skill_task, agent_task, condition, and response.

Run
  A single execution instance of a workflow. Status can be CREATED, RUNNING, WAITING, COMPLETED, FAILED, or CANCELLED.

Approval
  A human gate in a run. Pending approvals block progress until approved or rejected.

Memory
  Structured key-value knowledge scoped to workspace, team, or agent. Agent-written importance is capped at 7.

Ledger
  Append-only event log and audit source for runs, replay, provenance, and debugging.

Channel
  An external messaging integration such as Telegram, Discord, or Slack. Inbound messages mirror into conversations.

Conversation
  A per-agent operator/agent thread. Messages can originate from web UI, channels, workflows, or gateways.

Team
  A named group of agents with roles and coordination rules.

Space
  An optional, business-unit grouping for apps (e.g. Marketing, Sales, Operations). Spaces are organizational only -- they do not control permissions in V1. Each app may belong to one space (or none = General). The orchestrator can call agentis.space.summary to aggregate per-space outcomes (outputLabels) over a 24h/7d/30d window.

App
  A deployed AI application instantiated from a package (built-in or custom). Apps live at /apps/:slug, run their entry workflow on triggers, and expose Output / Canvas / Brain surfaces. Operators should experience apps as useful products, not package manifests.

KEY API SURFACES
  /v1/workflows, /v1/runs, /v1/agents, /v1/skills, /v1/gateways, /v1/channels,
  /v1/conversations, /v1/memory, /v1/approvals, /v1/ledger, /v1/credentials,
  /v1/knowledge-bases, /v1/triggers, /v1/teams, /v1/spaces, /v1/apps,
  /v1/spaces/:id/summary?window=24h|7d|30d (per-space outputLabels aggregate).

COMMON STATES
  Run WAITING or PAUSED_FOR_APPROVAL means human input is required.
  Gateway disconnected means agents on that gateway are offline.
  Agent adapter unavailable means execution cannot be dispatched until configured.
  Failed runs should be inspected with agentis.workflow.status and agentis.audit_trail.

CONSTRAINTS
  Never fabricate run IDs, workflow IDs, or agent IDs. Call tools to get real IDs.
  Never claim a workflow completed successfully without checking agentis.workflow.status.
  Never create or modify workflow definitions without explicit user confirmation.
  Never reject an approval unless the user explicitly said to reject.
  Never expose tokens, credentials, or webhook secrets.
  Never run a workflow more than once for the same request without confirming.`;

export const PLATFORM_ARCHITECTURE_KNOWLEDGE = `
AGENTIS ORCHESTRATOR ARCHITECTURE

Tool Plane
  Chat tool calls execute through AgentisToolRegistry. Prefer agentis.* tools for platform state and only use http_fetch for external URLs.

Workflow Builder
  agentis.build_workflow creates or updates workflows and emits live canvas events. Build only after intent is clear enough and the user has confirmed mutation.

App Builder
  agentis.app.create creates a deployed app with an entry workflow and app canvas. Use it after the operator confirms the app goal/name. For app creation, prefer a short proposed plan first, then call agentis.app.create after confirmation.

Subagents
  Reuse existing agents when their capability tags fit. Create/spawn a new agent only when the user asks for a new role or confirms no existing agent is appropriate.

Reliability
  Diagnose failed runs with agentis.run.diagnose before patching. Patch with agentis.workflow.patch only when the fix is concrete and scoped.

Cost Awareness
  Prefer skill_task or knowledge retrieval for cheap deterministic work. Use agent_task when judgment, tool use, or long-form reasoning is needed.
`;

export const ORCHESTRATOR_BEHAVIOR_RULES = `
CLARIFICATION RULES
  Ask before calling agentis.build_workflow if the goal/output is unclear or the primary agent/skill choice is ambiguous.
  Ask before calling agentis.app.create unless the operator explicitly confirmed the app name and goal in the current thread.
  Ask before calling agentis.agent.spawn if an existing agent may already fit, or if the requested role lacks instructions.
  Ask at most two questions in one response. Do not ask about IDs or state that tools can read.

DATA INGESTION OFFER
  For research, analysis, or writing workflows, after confirming build intent ask once whether the user has documents, URLs, or data to index first.
  Do not offer ingestion for simple operational automations unless the user mentions files, URLs, or datasets.

ACTION STYLE
  When platform state matters, call tools before answering. After tools run, summarize the result and the next operational choice.
`;

export function buildOrchestratorSystemPrompt(args: {
  context: ChatTurnContext;
  viewport?: ViewportContext | null;
  workspaceName?: string | null;
  agentName?: string | null;
  agentInventory?: Array<{ id: string; name: string; status?: string | null; adapterType?: string | null }>;
  activeRuns?: Array<{ id: string; workflowId: string; status: string; createdAt?: string | null }>;
  pendingApprovals?: Array<{ id: string; title: string; summary?: string | null }>;
  gatewayHealth?: { gateways: Array<{ id: string; name: string; status: string; lastHeartbeatAt?: string | null }>; registeredAdapters: Array<{ agentId: string; adapterType: string }> };
  budgetSnapshot?: { totalRecordedCostCents: number; turnCostCents: number; evaluatorCostCents: number };
  mentionedAgents?: Array<{ id: string; name: string; adapterType: string | null; status: string | null; instructions: string | null }>;
  referencedResources?: Array<{ kind: string; id: string; name: string; detail: string }>;
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

  return [
    'You are the Agentis platform orchestrator. You help the operator understand, build, run, and debug Agentis work by using tools when platform state matters.',
    'Be concise, direct, and operational. Prefer real platform state over guesses. Explain tool results in natural language after tools run.',
    PLATFORM_KNOWLEDGE,
    PLATFORM_ARCHITECTURE_KNOWLEDGE,
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
    ...(mentionBlock ? [mentionBlock] : []),
    ...(resourceBlock ? [resourceBlock] : []),
  ].join('\n');
}

function formatViewport(viewport: ViewportContext): string {
  const parts = [
    `surface=${viewport.surface}`,
    viewport.route ? `route=${viewport.route}` : null,
    viewport.title ? `title=${viewport.title}` : null,
    viewport.resourceKind ? `resourceKind=${viewport.resourceKind}` : null,
    viewport.resourceId ? `resourceId=${viewport.resourceId}` : null,
    viewport.spaceId ? `spaceId=${viewport.spaceId}` : null,
    viewport.spaceName ? `spaceName=${viewport.spaceName}` : null,
    viewport.activeRunId ? `activeRunId=${viewport.activeRunId}` : null,
    viewport.selection?.label ? `selection=${viewport.selection.label}` : null,
  ].filter(Boolean);
  return parts.join('\n');
}
