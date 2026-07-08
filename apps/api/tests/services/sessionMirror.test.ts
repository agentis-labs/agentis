/**
 * SessionMirror — V1-SPEC §0.3 item 23.
 *
 * Bridges OpenClaw Gateway events into ConversationStore + ApprovalInbox
 * + agent status writes. Only fires for known agentIds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type NormalizedAgentEvent } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { SessionMirror } from '../../src/services/sessionMirror.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let mirror: SessionMirror;
let conversations: ConversationStore;
let approvals: ApprovalInboxService;
let agentId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  mirror = new SessionMirror({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    conversations,
    approvals,
  });
  agentId = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      gatewayId: null,
      packageId: null,
      name: 'agent-x',
      adapterType: 'openclaw',
      capabilityTags: [],
      config: {},
      status: 'offline',
    })
    .run();
});
afterEach(() => ctx.close());

describe('SessionMirror', () => {
  it('agent.session_message is mirrored into ConversationStore', async () => {
    const event: NormalizedAgentEvent = {
      eventType: 'agent.session_message',
      agentId,
      sessionId: 'session-1',
      sessionMessageId: 'sm-1',
      authorType: 'agent',
      body: 'hello from agent',
      timestamp: new Date().toISOString(),
    };
    await mirror.handle(event, agentId);
    const list = conversations.list(ctx.workspace.id);
    expect(list).toHaveLength(1);
    const messages = conversations.messages(list[0]!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe('hello from agent');
    expect(messages[0]!.authorType).toBe('agent');
  });

  it('translates operator authorType to system on mirror (operator events come from the agent UI, not the dashboard)', async () => {
    const event: NormalizedAgentEvent = {
      eventType: 'agent.session_message',
      agentId,
      sessionId: 'session-1',
      sessionMessageId: 'sm-2',
      authorType: 'operator',
      body: 'sent via agent UI',
      timestamp: new Date().toISOString(),
    };
    await mirror.handle(event, agentId);
    const list = conversations.list(ctx.workspace.id);
    const messages = conversations.messages(list[0]!.id);
    expect(messages[0]!.authorType).toBe('system');
  });

  it('agent.approval_requested creates an ApprovalInbox row with source=openclaw_exec', async () => {
    const event: NormalizedAgentEvent = {
      eventType: 'agent.approval_requested',
      agentId,
      title: 'Run a thing',
      summary: 'wants to run a thing',
      timestamp: new Date().toISOString(),
    };
    await mirror.handle(event, agentId);
    const rows = ctx.db.select().from(schema.approvalRequests).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('openclaw_exec');
    expect(rows[0]!.title).toBe('Run a thing');
  });

  it('agent.status updates the agents row + publishes AGENT_STATUS_CHANGED', async () => {
    const events: string[] = [];
    ctx.bus.subscribe((m) => events.push(m.envelope.event));
    const event: NormalizedAgentEvent = {
      eventType: 'agent.status',
      agentId,
      status: 'busy',
      timestamp: new Date().toISOString(),
    };
    await mirror.handle(event, agentId);
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;
    expect(row.status).toBe('busy');
    expect(events).toContain(REALTIME_EVENTS.AGENT_STATUS_CHANGED);
  });

  it('agent.heartbeat updates lastHeartbeatAt without publishing', async () => {
    const events: string[] = [];
    ctx.bus.subscribe((m) => events.push(m.envelope.event));
    const ts = new Date().toISOString();
    const event: NormalizedAgentEvent = {
      eventType: 'agent.heartbeat',
      agentId,
      connected: true,
      timestamp: ts,
    };
    await mirror.handle(event, agentId);
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;
    expect(row.lastHeartbeatAt).toBe(ts);
    expect(events.some((e) => e === REALTIME_EVENTS.AGENT_STATUS_CHANGED)).toBe(false);
  });

  it('returns silently when agentId is unknown', async () => {
    const event: NormalizedAgentEvent = {
      eventType: 'agent.status',
      agentId: 'unknown',
      status: 'busy',
      timestamp: new Date().toISOString(),
    };
    await expect(mirror.handle(event, 'unknown')).resolves.toBeUndefined();
  });

  it('bind() forwards events from the supplied register hook and returns an unsubscribe', async () => {
    const handlers: Array<(event: NormalizedAgentEvent, agentId: string) => void> = [];
    const register = (h: (event: NormalizedAgentEvent, agentId: string) => void) => {
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    };
    const unsubscribe = mirror.bind(register);
    expect(handlers).toHaveLength(1);
    handlers[0]!(
      {
        eventType: 'agent.status',
        agentId,
        status: 'online',
        timestamp: new Date().toISOString(),
      } as NormalizedAgentEvent,
      agentId,
    );
    // microtask: handle is async, give it a tick.
    await new Promise((r) => setImmediate(r));
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;
    expect(row.status).toBe('online');
    unsubscribe();
    expect(handlers).toHaveLength(0);
  });
});
