/**
 * /v1/admin — internal platform observability endpoints.
 *
 *   GET /metrics   — per-tool call latency (p50/p95/avg) + error rates, plus the
 *                    per-turn CLB stage breakdown (context / first-token / model
 *                    / tools / total). CHAT-AGENT-LOOP.md §9 + NATIVE-ADVANCEMENT
 *                    Phase A.
 *
 * Protected by normal auth; operators must be authenticated. In a multi-tenant
 * setup you'd additionally restrict to workspace admins — for V1 auth is enough.
 */

import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { getToolMetrics, getTurnMetrics, resetToolMetrics } from '../services/chatMetrics.js';

export function buildAdminRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps));

  /** GET /v1/admin/metrics — chat tool call statistics + per-turn CLB timings. */
  app.get('/metrics', (c) => {
    const tools = getToolMetrics();
    return c.json({
      generatedAt: new Date().toISOString(),
      totalCalls: tools.reduce((sum, t) => sum + t.calls, 0),
      tools,
      turns: getTurnMetrics(),
    });
  });

  /** DELETE /v1/admin/metrics — reset in-memory stats (useful in tests / staging). */
  app.delete('/metrics', (c) => {
    resetToolMetrics();
    return c.json({ ok: true });
  });

  return app;
}
