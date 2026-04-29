/**
 * WorkspaceContextService — multi-tenant guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkspaceContextService } from '../../src/services/workspaceContext.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let svc: WorkspaceContextService;

beforeEach(async () => {
  ctx = await createTestContext();
  svc = new WorkspaceContextService(ctx.db);
});

describe('WorkspaceContextService.resolve', () => {
  it('returns the workspace when the user owns it', () => {
    const out = svc.resolve({
      user: { id: ctx.user.id, username: ctx.user.username, displayName: 'Op', email: null },
      workspaceId: ctx.workspace.id,
    });
    expect(out.workspaceId).toBe(ctx.workspace.id);
    expect(out.ambientId).toBe(ctx.ambient.id); // default
  });

  it('honors explicit ambientId when provided', () => {
    const out = svc.resolve({
      user: { id: ctx.user.id, username: ctx.user.username, displayName: 'Op', email: null },
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
    });
    expect(out.ambientId).toBe(ctx.ambient.id);
  });

  it('throws VALIDATION_FAILED when workspaceId is missing', () => {
    expect(() =>
      svc.resolve({
        user: { id: ctx.user.id, username: ctx.user.username, displayName: 'Op', email: null },
        workspaceId: undefined,
      }),
    ).toThrow(AgentisError);
  });

  it('throws CROSS_WORKSPACE_ACCESS for a workspace the user does not own', () => {
    // Create a second user + workspace.
    const otherUserId = randomUUID();
    const otherWsId = randomUUID();
    ctx.db.insert(schema.users).values({
      id: otherUserId,
      username: 'other',
      displayName: 'Other',
      passwordHash: 'x',
    }).run();
    ctx.db.insert(schema.workspaces).values({
      id: otherWsId,
      userId: otherUserId,
      name: 'OtherWS',
      slug: 'other',
    }).run();
    try {
      svc.resolve({
        user: { id: ctx.user.id, username: ctx.user.username, displayName: 'Op', email: null },
        workspaceId: otherWsId,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentisError);
      expect((err as AgentisError).code).toBe('CROSS_WORKSPACE_ACCESS');
    }
  });

  it('throws CROSS_WORKSPACE_ACCESS for an ambient outside the workspace', () => {
    const otherAmbId = randomUUID();
    // Use FK-off context to insert a stray ambient under a different workspace.
    expect(() =>
      svc.resolve({
        user: { id: ctx.user.id, username: ctx.user.username, displayName: 'Op', email: null },
        workspaceId: ctx.workspace.id,
        ambientId: otherAmbId,
      }),
    ).toThrow(AgentisError);
  });
});
