import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerPermissionTools } from '../../src/services/agentisToolHandlers/permissions.js';
import { registerBrowserTools } from '../../src/services/agentisToolHandlers/browser.js';
import { registerChannelTools } from '../../src/services/agentisToolHandlers/channel.js';
import { decideToolApproval } from '../../src/services/chat/chatApprovalPolicy.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('agentis.permissions.configure', () => {
  it('persists a conversation preference from Ask mode without self-blocking', async () => {
    const agentId = randomUUID();
    const conversationId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Agent',
      adapterType: 'http',
    }).run();
    ctx.db.insert(schema.conversations).values({
      id: conversationId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerPermissionTools(registry, { db: ctx.db } as ToolHandlerDeps);
    const result = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.permissions.configure',
      arguments: { sensitivity: 'autonomous' },
    }, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      agentId,
      conversationId,
      executionMode: 'ask',
      approvalSensitivity: 'balanced',
      caller: 'chat',
    });

    expect(result.ok).toBe(true);
    const row = ctx.db.select({ sensitivity: schema.conversations.approvalSensitivity })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get();
    expect(row?.sensitivity).toBe('autonomous');
  });

  it('allows a requested screenshot in balanced Ask mode', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBrowserTools(registry, {
      db: ctx.db,
      browserPool: { screenshot: async () => Buffer.from('png') },
    } as unknown as ToolHandlerDeps);

    const result = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.browser.screenshot',
      arguments: { url: 'https://example.com' },
    }, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      executionMode: 'ask',
      approvalSensitivity: 'balanced',
      artifactPolicy: { mode: 'none' },
      caller: 'chat',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ saved: false, mimeType: 'image/png' });
  });

  it('classifies ordinary channel delivery below the balanced Ask threshold', () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerChannelTools(registry, { db: ctx.db } as ToolHandlerDeps);
    const definition = registry.get('agentis.channel.send');
    expect(decideToolApproval({
      name: 'agentis.channel.send',
      definition,
      permissionMode: 'ask',
      sensitivity: 'balanced',
    }).requiresApproval).toBe(false);
  });
});
import { randomUUID } from 'node:crypto';
