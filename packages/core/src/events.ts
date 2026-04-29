/**
 * Realtime event names — V1-SPEC §12.
 *
 * The room set + event family are a closed enumeration. The dashboard's
 * `useRealtime()` hook uses these names directly; do not introduce magic
 * strings elsewhere.
 */

export const REALTIME_EVENTS = {
  // Workspace
  WORKSPACE_SELECTED: 'workspace.selected',
  AMBIENT_SELECTED: 'ambient.selected',

  // Fleet overview
  FLEET_SNAPSHOT_UPDATED: 'fleet.snapshot.updated',

  // Gateway
  GATEWAY_CONNECTED: 'gateway.connected',
  GATEWAY_DEGRADED: 'gateway.degraded',
  GATEWAY_DISCONNECTED: 'gateway.disconnected',
  GATEWAY_EVENT: 'gateway.event',

  // Agents
  AGENT_CREATED: 'agent.created',
  AGENT_UPDATED: 'agent.updated',
  AGENT_STATUS_CHANGED: 'agent.status.changed',
  AGENT_HEARTBEAT: 'agent.heartbeat',

  // Workflows
  WORKFLOW_CREATED: 'workflow.created',
  WORKFLOW_UPDATED: 'workflow.updated',
  WORKFLOW_GRAPH_PATCHED: 'workflow.graph_patched',

  // Runs
  RUN_CREATED: 'run.created',
  RUN_RUNNING: 'run.running',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',

  // Nodes
  NODE_STARTED: 'node.started',
  NODE_COMPLETED: 'node.completed',
  NODE_FAILED: 'node.failed',
  NODE_WAITING_FOR_INPUT: 'node.waiting_for_input',

  // Presence (ephemeral, never persisted)
  AGENT_PRESENCE_FOCUS: 'agent.presence.focus',
  AGENT_PRESENCE_BLUR: 'agent.presence.blur',
  AGENT_PRESENCE_THINKING: 'agent.presence.thinking',
  AGENT_TERMINAL_MESSAGE: 'agent.terminal.message',
  AGENT_TERMINAL_TOOL_CALL: 'agent.terminal.tool_call',

  // Activity / approvals
  ACTIVITY_CREATED: 'activity.created',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',

  // State surfaces
  SCRATCHPAD_WRITTEN: 'scratchpad.written',
  LEDGER_EVENT: 'ledger.event',
  COMMAND_INDEX_UPDATED: 'command.index.updated',

  // Skill registry
  SKILL_REGISTRY_INSTALLED: 'skill_registry.installed',

  // Conversation continuity
  CONVERSATION_MESSAGE_RECEIVED: 'conversation.message.received',
  CONVERSATION_MESSAGE_SENT: 'conversation.message.sent',
  CONVERSATION_AGENT_TYPING: 'conversation.agent.typing',
  CONVERSATION_SESSION_DISCOVERED: 'conversation.session.discovered',
  CONVERSATION_SESSION_SYNCED: 'conversation.session.synced',
  CONVERSATION_SESSION_STALE: 'conversation.session.stale',

  // Channel bridge (Batch 4 / V1-SPEC §0.3 #24, §11)
  CHANNEL_MESSAGE_RECEIVED: 'channel.message.received',
  CHANNEL_MESSAGE_SENT: 'channel.message.sent',
  CHANNEL_CONNECTION_STATUS: 'channel.connection.status',
} as const;

export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export const REALTIME_ROOMS = {
  user: (userId: string) => `user:${userId}`,
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  workflow: (workflowId: string) => `workflow:${workflowId}`,
  run: (runId: string) => `run:${runId}`,
  gateway: (gatewayId: string) => `gateway:${gatewayId}`,
  agent: (agentId: string) => `agent:${agentId}`,
  conversation: (agentId: string) => `conversation:${agentId}`,
} as const;

export interface RealtimeEnvelope<TName extends RealtimeEventName = RealtimeEventName> {
  event: TName;
  payload: unknown;
  /** ISO-8601 server timestamp the event was emitted at. */
  emittedAt: string;
  /** Optional correlation id for tracing client → server → adapter chains. */
  correlationId?: string;
}
