/**
 * /v1/capabilities - the unified native/app/plugin capability surface.
 *
 * Native tools, App actions, and plugin/Agent-Service operations all dispatch
 * through CapabilityRegistry.invoke so validation, authz seams, and ledger
 * records do not drift into separate paths.
 */

import { Hono } from 'hono';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CapabilityRegistry } from '../services/capabilityRegistry.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export interface CapabilityRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  capabilities: CapabilityRegistry;
}

export function buildCapabilityRoutes(deps: CapabilityRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.query('appId');
    if (appId) deps.capabilities.registerAppCapabilities({ workspaceId: ws.workspaceId, appId });
    const source = capabilitySource(c.req.query('source'));
    const tag = c.req.query('tag');
    const filter = {
      ...(source ? { source } : {}),
      ...(tag ? { tag } : {}),
    };
    const capabilities = deps.capabilities.list(filter);
    return c.json({ data: { count: capabilities.length, capabilities } });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    maybeRefreshApp(deps.capabilities, ws.workspaceId, id);
    const capability = deps.capabilities.list().find((cap) => cap.id === id);
    if (!capability) throw new AgentisError('RESOURCE_NOT_FOUND', `capability '${id}' not found`);
    return c.json({ data: capability });
  });

  app.post('/:id/invoke', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    maybeRefreshApp(deps.capabilities, ws.workspaceId, id);
    const body = (await c.req.json().catch(() => ({}))) as {
      input?: unknown;
      args?: unknown;
      callerAgentId?: string;
      callingAppId?: string;
      runId?: string;
    };
    const output = await deps.capabilities.invoke(id, body.input ?? body.args ?? {}, {
      workspaceId: ws.workspaceId,
      actingSeatId: ws.user.id,
      ambientId: ws.ambientId ?? null,
      ...(body.callerAgentId ? { callerAgentId: body.callerAgentId } : {}),
      ...(body.callingAppId ? { appId: body.callingAppId } : {}),
      ...(body.runId ? { runId: body.runId } : {}),
    });
    return c.json({ data: output });
  });

  return app;
}

function maybeRefreshApp(registry: CapabilityRegistry, workspaceId: string, capabilityId: string): void {
  if (!capabilityId.startsWith('app.')) return;
  const [, appId] = capabilityId.split('.');
  if (appId) registry.registerAppCapabilities({ workspaceId, appId });
}

function capabilitySource(value: string | undefined): 'native' | 'app' | 'plugin' | undefined {
  return value === 'native' || value === 'app' || value === 'plugin' ? value : undefined;
}
