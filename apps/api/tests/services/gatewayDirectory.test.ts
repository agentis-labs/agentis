/**
 * GatewayDirectoryService — read-side queries with workspace scope.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { GatewayDirectoryService } from '../../src/services/gatewayDirectory.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dir: GatewayDirectoryService;
let g1: string;
let g2: string;

beforeEach(async () => {
  ctx = await createTestContext();
  dir = new GatewayDirectoryService(ctx.db);
  g1 = randomUUID();
  g2 = randomUUID();
  ctx.db.insert(schema.openclawGateways).values([
    {
      id: g1,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'GW-1',
      gatewayUrl: 'https://g1',
      status: 'connected',
    },
    {
      id: g2,
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      name: 'GW-2',
      gatewayUrl: 'https://g2',
      status: 'disconnected',
    },
  ]).run();
});

describe('GatewayDirectoryService', () => {
  it('byId returns the row when the gateway belongs to the workspace', () => {
    const row = dir.byId(ctx.workspace.id, g1);
    expect(row.name).toBe('GW-1');
  });

  it('byId throws RESOURCE_NOT_FOUND for unknown id', () => {
    try {
      dir.byId(ctx.workspace.id, randomUUID());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentisError);
      expect((err as AgentisError).code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('listByWorkspace returns both gateways', () => {
    expect(dir.listByWorkspace(ctx.workspace.id).length).toBe(2);
  });

  it('listByAmbient(null) returns only ambient-less gateways', () => {
    const list = dir.listByAmbient(ctx.workspace.id, null);
    expect(list.map((g) => g.id)).toEqual([g2]);
  });

  it('listByAmbient(ambientId) returns only matching gateways', () => {
    const list = dir.listByAmbient(ctx.workspace.id, ctx.ambient.id);
    expect(list.map((g) => g.id)).toEqual([g1]);
  });
});
