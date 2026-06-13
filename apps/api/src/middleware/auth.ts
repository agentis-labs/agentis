/**
 * Hono middleware: auth.
 *
 * Bearer-token JWT via jose. Verified token claims become `c.get('user')`
 * and the per-request workspace context is resolved by `workspaceContext`.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { AgentisError, type AuthenticatedUser } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { hashApiKey } from '../services/apiKeys.js';

export type AuthVariables = {
  user: AuthenticatedUser;
};

export function requireAuth(deps: { db: AgentisSqliteDb; auth: AuthService }): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.toLowerCase().startsWith('bearer ')) {
      throw new AgentisError('AUTH_TOKEN_INVALID', 'Missing bearer token');
    }
    const token = header.slice('bearer '.length).trim();
    let userId: string;
    try {
      const claims = await deps.auth.verify(token, 'access');
      userId = claims.sub;
    } catch (err) {
      const workspaceId = c.req.header('x-agentis-workspace');
      if (!token.startsWith('agt_') || !workspaceId) throw err;
      const key = deps.db
        .select()
        .from(schema.apiKeys)
        .where(and(
          eq(schema.apiKeys.workspaceId, workspaceId),
          eq(schema.apiKeys.keyHash, hashApiKey(token)),
          isNull(schema.apiKeys.revokedAt),
        ))
        .get();
      if (!key) throw new AgentisError('AUTH_TOKEN_INVALID', 'Invalid API key');
      userId = key.userId;
      deps.db.update(schema.apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(schema.apiKeys.id, key.id)).run();
    }
    const row = deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    if (!row) {
      throw new AgentisError('AUTH_TOKEN_INVALID', 'User no longer exists');
    }
    const user: AuthenticatedUser = {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      email: row.email ?? null,
    };
    c.set('user', user);
    await next();
  };
}

export function getUser(c: Context): AuthenticatedUser {
  const u = c.get('user') as AuthenticatedUser | undefined;
  if (!u) throw new AgentisError('AUTH_TOKEN_INVALID', 'No authenticated user on context');
  return u;
}
