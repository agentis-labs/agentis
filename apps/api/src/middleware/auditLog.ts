/**
 * Universal audit middleware (Batch 8 / D38).
 *
 * Writes one `activity_events` row for every successful state-changing
 * `/v1/*` call so the operator audit trail is complete by construction
 * instead of relying on each route handler to remember.
 *
 * Why activity_events and not ledger_events:
 *   `ledger_events.run_id` is `NOT NULL` with an FK to `workflow_runs`, so
 *   it can only describe events that belong to a specific run. State changes
 *   like creating a credential or pairing a gateway have no run context.
 *   `activity_events` is workspace-scoped and was built for exactly this
 *   "who did what to which resource" timeline.
 *
 * Why a path-prefix table instead of route decorators:
 *   The 20+ route modules already share the `requireAuth + requireWorkspace`
 *   stack; the actor and workspace are already on `c`. A single middleware
 *   mounted on `/v1/*` keeps the rule "every state-changing route is
 *   audited" in one place — adding a new route file requires zero audit
 *   wiring as long as it sits under one of the known prefixes.
 *
 * Opt-out:
 *   Routes that already publish a richer entry to ActivityFeedService
 *   (today: skill registry install) sit under SKIP_PATHS so we don't
 *   double-record. A handler can also set `c.set('audit.skip', true)` to
 *   suppress for one request.
 */

import type { MiddlewareHandler } from 'hono';
import type { ActivityFeedService } from '../services/activityFeed.js';
import type { Logger } from '../logger.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface ResourceMatcher {
  pattern: RegExp;
  entityType: string;
}

/** First match wins. Order matters when prefixes overlap. */
const RESOURCES: ResourceMatcher[] = [
  { pattern: /^\/v1\/workflows(?:\/|$)/, entityType: 'workflow' },
  { pattern: /^\/v1\/runs(?:\/|$)/, entityType: 'run' },
  { pattern: /^\/v1\/skills(?:\/|$)/, entityType: 'skill' },
  { pattern: /^\/v1\/packages(?:\/|$)/, entityType: 'package' },
  { pattern: /^\/v1\/agents(?:\/|$)/, entityType: 'agent' },
  { pattern: /^\/v1\/gateways(?:\/|$)/, entityType: 'gateway' },
  { pattern: /^\/v1\/triggers(?:\/|$)/, entityType: 'trigger' },
  { pattern: /^\/v1\/credentials(?:\/|$)/, entityType: 'credential' },
  { pattern: /^\/v1\/conversations(?:\/|$)/, entityType: 'conversation' },
  { pattern: /^\/v1\/channels(?:\/|$)/, entityType: 'channel' },
  { pattern: /^\/v1\/approvals(?:\/|$)/, entityType: 'approval' },
  { pattern: /^\/v1\/workspaces(?:\/|$)/, entityType: 'workspace' },
  { pattern: /^\/v1\/ambients(?:\/|$)/, entityType: 'ambient' },
  { pattern: /^\/v1\/tasks(?:\/|$)/, entityType: 'task' },
];

/** Routes that already publish their own activity rows or have no workspace context. */
const SKIP_PATHS: RegExp[] = [
  /^\/v1\/skills\/registry(?:\/|$)/, // skillRegistry.ts records its own install events
  /^\/v1\/auth(?:\/|$)/, // login/refresh — auth-event audit is its own concern
  /^\/v1\/_test(?:\/|$)/, // test harness reset is not a real operator action
  /^\/v1\/webhooks(?:\/|$)/, // unauthenticated ingress; no workspace/user context
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Words that should not be used as the entity id when they appear at the path tail. */
const TERMINAL_VERBS = new Set([
  'run',
  'cancel',
  'sync',
  'pair',
  'install-local',
  'send',
  'continue',
  'read',
  'select',
  'resolve',
  'replay',
  'test',
  'refresh',
  'me',
  'login',
]);

function extractEntityId(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  // Prefer a UUID anywhere in the path (e.g. /v1/workflows/:id/run).
  for (let i = segments.length - 1; i >= 0; i--) {
    if (UUID_RE.test(segments[i]!)) return segments[i]!;
  }
  // Fall back to the last segment if it isn't a custom verb.
  const last = segments[segments.length - 1];
  if (last && !TERMINAL_VERBS.has(last)) return last;
  return null;
}

function actionFor(method: string, pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && TERMINAL_VERBS.has(last)) return last;
  switch (method) {
    case 'POST':
      return 'create';
    case 'PATCH':
    case 'PUT':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return method.toLowerCase();
  }
}

export interface AuditLogDeps {
  activity: ActivityFeedService;
  logger: Logger;
}

interface WorkspaceCtx {
  workspaceId: string;
  ambientId: string | null;
}

interface UserCtx {
  id: string;
  username?: string;
}

export function auditLog({ activity, logger }: AuditLogDeps): MiddlewareHandler {
  return async (c, next) => {
    await next();

    try {
      const method = c.req.method;
      if (!STATE_CHANGING.has(method)) return;

      const status = c.res.status;
      if (status < 200 || status >= 300) return;

      const pathname = new URL(c.req.url).pathname;
      if (SKIP_PATHS.some((p) => p.test(pathname))) return;
      if (c.get('audit.skip')) return;

      const ws = c.get('workspace') as WorkspaceCtx | undefined;
      const user = c.get('user') as UserCtx | undefined;
      if (!ws || !user) return;

      const matcher = RESOURCES.find((r) => r.pattern.test(pathname));
      if (!matcher) return;

      const action = actionFor(method, pathname);
      const entityId = extractEntityId(pathname) ?? matcher.entityType;
      const actorLabel = user.username ?? user.id;

      activity.record({
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: user.id,
        eventType: `${matcher.entityType}.${action}`,
        actorType: 'user',
        actorId: user.id,
        entityType: matcher.entityType,
        entityId,
        summary: `${actorLabel} ${action} ${matcher.entityType} ${entityId}`,
        metadata: { method, path: pathname, status },
      });
    } catch (err) {
      logger.warn('audit.middleware_failed', {
        err: (err as Error).message,
        path: new URL(c.req.url).pathname,
      });
    }
  };
}
