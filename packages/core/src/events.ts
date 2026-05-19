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
  AGENT_WORK_STEP: 'agent.work.step',
  AGENT_WAKE_REQUESTED: 'agent.wake.requested',
  AGENT_PROACTIVE_PUSH: 'agent.proactive.push',

  // Management layer
  GOAL_CREATED: 'goal.created',
  GOAL_UPDATED: 'goal.updated',
  ISSUE_CREATED: 'issue.created',
  ISSUE_UPDATED: 'issue.updated',
  ROUTINE_CREATED: 'routine.created',
  ROUTINE_UPDATED: 'routine.updated',
  BUDGET_EVENT_CREATED: 'budget.event.created',
  INBOX_UPDATED: 'inbox.updated',

  // Workflows
  WORKFLOW_CREATED: 'workflow.created',
  WORKFLOW_UPDATED: 'workflow.updated',
  WORKFLOW_DELETED: 'workflow.deleted',
  WORKFLOW_GRAPH_PATCHED: 'workflow.graph_patched',

  // Runs
  RUN_CREATED: 'run.created',
  RUN_RUNNING: 'run.running',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  RUN_RECOVERED: 'run.recovered',
  RUN_QUEUED: 'run.queued',
  RUN_DEQUEUED: 'run.dequeued',

  // Nodes
  NODE_STARTED: 'node.started',
  NODE_COMPLETED: 'node.completed',
  NODE_FAILED: 'node.failed',
  NODE_WAITING_FOR_INPUT: 'node.waiting_for_input',
  NODE_RETRY_SCHEDULED: 'node.retry_scheduled',
  NODE_CACHE_HIT: 'node.cache_hit',
  NODE_COMPRESS_STATS: 'node.compress_stats',
  NODE_SURGICAL_RETRY: 'node.surgical_retry',

  // Scheduler / event chains
  SCHEDULE_FIRED: 'schedule.fired',
  EVENT_CHAIN_FIRED: 'event_chain.fired',
  WATCHDOG_TIMEOUT: 'watchdog.timeout',

  // Presence (ephemeral, never persisted)
  AGENT_PRESENCE_FOCUS: 'agent.presence.focus',
  AGENT_PRESENCE_BLUR: 'agent.presence.blur',
  AGENT_PRESENCE_THINKING: 'agent.presence.thinking',
  AGENT_TERMINAL_MESSAGE: 'agent.terminal.message',
  AGENT_TERMINAL_TOOL_CALL: 'agent.terminal.tool_call',
  AGENT_TASK_COMPLETED: 'agent.task.completed',

  // Activity / approvals
  ACTIVITY_CREATED: 'activity.created',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',

  // Artifacts
  ARTIFACT_CREATED: 'artifact.created',
  ARTIFACT_UPDATED: 'artifact.updated',
  ARTIFACT_DELETED: 'artifact.deleted',

  // Spaces
  SPACE_CREATED: 'space.created',
  SPACE_UPDATED: 'space.updated',
  SPACE_DELETED: 'space.deleted',

  // Teams
  TEAM_CREATED: 'team.created',
  TEAM_UPDATED: 'team.updated',
  TEAM_DELETED: 'team.deleted',
  TEAM_CONTEXT_UPDATED: 'team.context.updated',

  // State surfaces
  SCRATCHPAD_WRITTEN: 'scratchpad.written',
  LEDGER_EVENT: 'ledger.event',
  COMMAND_INDEX_UPDATED: 'command.index.updated',

  // Skill registry
  SKILL_REGISTRY_INSTALLED: 'skill_registry.installed',

  // Conversation continuity
  CONVERSATION_MESSAGE_RECEIVED: 'conversation.message.received',
  CONVERSATION_MESSAGE_SENT: 'conversation.message.sent',
  CONVERSATION_MESSAGE_UPDATED: 'conversation.message.updated',
  CONVERSATION_MESSAGE_DELETED: 'conversation.message.deleted',
  CONVERSATION_AGENT_TYPING: 'conversation.agent.typing',
  CONVERSATION_SESSION_DISCOVERED: 'conversation.session.discovered',
  CONVERSATION_SESSION_SYNCED: 'conversation.session.synced',
  CONVERSATION_SESSION_STALE: 'conversation.session.stale',

  // Channel bridge (Batch 4 / V1-SPEC §0.3 #24, §11)
  CHANNEL_MESSAGE_RECEIVED: 'channel.message.received',
  CHANNEL_MESSAGE_SENT: 'channel.message.sent',
  CHANNEL_CONNECTION_STATUS: 'channel.connection.status',

  // Package library
  PACKAGE_INSTALLED: 'package.installed',

  // Rooms
  ROOM_CREATED: 'room.created',
  ROOM_UPDATED: 'room.updated',
  ROOM_DELETED: 'room.deleted',
  ROOM_MESSAGE_SENT: 'room.message.sent',
  ROOM_MESSAGE_RECEIVED: 'room.message.received',
  ROOM_MESSAGE_UPDATED: 'room.message.updated',
  ROOM_MESSAGE_DELETED: 'room.message.deleted',
  ROOM_AGENT_JOINED: 'room.agent.joined',
  ROOM_AGENT_LEFT: 'room.agent.left',

  // Canvas narration
  CANVAS_NODE_PLACED: 'canvas.node.placed',
  CANVAS_EDGE_CONNECTED: 'canvas.edge.connected',
  CANVAS_BUILD_COMPLETE: 'canvas.build.complete',
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
  room: (roomId: string) => `room:${roomId}`,
} as const;

export interface RealtimeEnvelope<TName extends RealtimeEventName = RealtimeEventName> {
  event: TName;
  payload: unknown;
  /** ISO-8601 server timestamp the event was emitted at. */
  emittedAt: string;
  /** Optional correlation id for tracing client → server → adapter chains. */
  correlationId?: string;
}
