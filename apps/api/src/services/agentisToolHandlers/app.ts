/**
 * App-layer tools — APP-OUTPUT-REPLAN.md §10.4 + §10.3.
 *
 *   - `agentis.apps.run_status` — workspace orchestrator's cross-app overview.
 *     Returns one row per app: idle/running/completed-recently with last
 *     result summary. Used at /chat for "What are all my apps doing?".
 *
 *   - `agentis.app.thread.open` — workspace-orchestrator-only handoff tool
 *     that signals the UI to navigate to a specific App Thread carrying the
 *     operator's original message. The tool's "result" is a structured
 *     payload the chat surface interprets (no server-side state mutation).
 *
 *   - `agentis.app.thread.append` — append a structured message to an App
 *     Thread (used by background tasks; rarely needed for chat).
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import type { AppResultsService } from '../appResultsService.js';
import type { AppThreadService } from '../appThreadService.js';
import { AgentisError } from '@agentis/core';

export interface AppToolDeps extends ToolHandlerDeps {
  appResults: AppResultsService;
  appThread: AppThreadService;
}

export function registerAppTools(registry: AgentisToolRegistry, deps: AppToolDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.apps.run_status',
        family: 'inspect',
        description:
          'Cross-app run status overview for the workspace orchestrator (/chat). Returns one row per installed app with its current run status (idle/running/completed/failed) and a summary of the most recent result. Use when the operator asks "what are all my apps doing" or wants a fleet view.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Cap the number of apps returned (default 50).' },
          },
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 200);
        const apps = deps.db
          .select()
          .from(schema.appInstances)
          .where(eq(schema.appInstances.workspaceId, ctx.workspaceId))
          .orderBy(desc(schema.appInstances.updatedAt))
          .limit(limit)
          .all();

        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        return {
          apps: apps.map((app) => {
            const activeRun = app.entryWorkflowId
              ? deps.db
                  .select()
                  .from(schema.workflowRuns)
                  .where(
                    and(
                      eq(schema.workflowRuns.workflowId, app.entryWorkflowId),
                      eq(schema.workflowRuns.workspaceId, ctx.workspaceId),
                    ),
                  )
                  .orderBy(desc(schema.workflowRuns.createdAt))
                  .limit(1)
                  .get()
              : undefined;
            const recent = deps.appResults.list({ workspaceId: ctx.workspaceId, appId: app.id, limit: 1 });
            const last = recent[0] ?? null;
            const isRunning = activeRun?.status === 'RUNNING';
            const recentRunCount = app.entryWorkflowId
              ? deps.db
                  .select()
                  .from(schema.workflowRuns)
                  .where(
                    and(
                      eq(schema.workflowRuns.workflowId, app.entryWorkflowId),
                      eq(schema.workflowRuns.workspaceId, ctx.workspaceId),
                      gte(schema.workflowRuns.createdAt, since),
                    ),
                  )
                  .all().length
              : 0;
            return {
              appId: app.id,
              slug: app.slug,
              name: app.name,
              status: app.status,
              entryWorkflowId: app.entryWorkflowId,
              currentRun: activeRun
                ? {
                    runId: activeRun.id,
                    status: activeRun.status,
                    startedAt: activeRun.startedAt,
                    isRunning,
                  }
                : null,
              lastResult: last
                ? {
                    resultId: last.id,
                    summary: last.summary,
                    artifactType: last.artifactType,
                    triggeredBy: last.triggeredBy,
                    createdAt: last.createdAt,
                  }
                : null,
              recentRunCount7d: recentRunCount,
            };
          }),
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.thread.open',
        family: 'environment',
        description:
          "Hand off the operator from /chat to a specific App Thread. Use this when the operator's intent at /chat names or implies one specific app. The UI receives this tool result and navigates to /apps/:slug pre-filling the composer with the carried message. This tool does NOT mutate state.",
        inputSchema: {
          type: 'object',
          properties: {
            appSlug: { type: 'string', description: 'Slug or id of the target app.' },
            carriedMessage: {
              type: 'string',
              description: "The operator's original message to pre-fill in the App Thread composer.",
            },
            reason: { type: 'string', description: 'Short explanation displayed in /chat before navigation.' },
          },
          required: ['appSlug'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const slug = String(args.appSlug);
        const app = deps.db
          .select()
          .from(schema.appInstances)
          .where(
            and(
              eq(schema.appInstances.workspaceId, ctx.workspaceId),
              eq(schema.appInstances.slug, slug),
            ),
          )
          .get();
        if (!app) throw new AgentisError('RESOURCE_NOT_FOUND', `app '${slug}' not installed`);
        return {
          handoff: 'app_thread.open',
          appId: app.id,
          slug: app.slug,
          name: app.name,
          carriedMessage: args.carriedMessage ? String(args.carriedMessage) : null,
          reason: args.reason ? String(args.reason) : null,
          targetUrl: `/apps/${app.slug}`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.thread.append',
        family: 'environment',
        description:
          'Append a structured message to an App Thread. Use sparingly — the operator-facing thread is typically driven by ChatSessionExecutor turns and the RUN_COMPLETED bus listener. Useful for system / error cards from background tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            kind: { type: 'string', enum: ['message', 'progress', 'result', 'checkpoint', 'error'] },
            role: { type: 'string', enum: ['operator', 'app', 'system'] },
            content: {},
            runId: { type: 'string' },
          },
          required: ['appId', 'kind', 'role', 'content'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const appId = String(args.appId);
        const app = deps.db
          .select()
          .from(schema.appInstances)
          .where(
            and(
              eq(schema.appInstances.workspaceId, ctx.workspaceId),
              eq(schema.appInstances.id, appId),
            ),
          )
          .get();
        if (!app) throw new AgentisError('RESOURCE_NOT_FOUND', `app '${appId}' not installed`);
        const message = deps.appThread.append({
          appId: app.id,
          workspaceId: ctx.workspaceId,
          entryWorkflowId: app.entryWorkflowId,
          role: args.role as 'operator' | 'app' | 'system',
          kind: args.kind as 'message' | 'progress' | 'result' | 'checkpoint' | 'error',
          content: args.content,
          runId: args.runId ? String(args.runId) : null,
        });
        return { messageId: message.id, createdAt: message.createdAt };
      },
    },
  ]);
}

/**
 * Tool ID subset granted to the App Thread orchestrator.
 *
 * APP-OUTPUT-REPLAN.md §5.5: "The App Thread orchestrator does NOT have
 * access to the full CHAT_TOOL_CATALOG."
 */
export const APP_THREAD_TOOL_IDS = new Set<string>([
  'agentis.workflow.run',
  'agentis.workflow.status',
  'agentis.workflow.list',
  'agentis.run.cancel',
  'agentis.run.status',
  'agentis.run.diagnose',
  'agentis.approval.list',
  'agentis.approval.resolve',
  'agentis.knowledge.search',
  'agentis.memory.read',
  'agentis.brain.search',
  'agentis.brain.add',
  'agentis.brain.summarize',
  'agentis.brain.refresh',
  'agentis.brain.preload',
  'agentis.brain.forget',
  'agentis.session.search',
  'agentis.app.thread.append',
]);
