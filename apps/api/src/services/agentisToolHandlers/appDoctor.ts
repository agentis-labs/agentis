/** Read-only agent tool for cross-layer App conformance inspection. */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { collectAppDoctorSnapshot } from '../app/appDoctorSnapshot.js';
import { validateAppConformance } from '../app/appDoctor.js';
import { migrateWorkspaceAppConformance, repairAppConformance } from '../app/appDoctorRepair.js';

export function registerAppDoctorTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const resolveAppId = (args: Record<string, unknown>, ctx: { viewport?: { resourceKind?: string; resourceId?: string } | null; appId?: string | null }): string => {
    const explicit = typeof args.appId === 'string' ? args.appId.trim() : '';
    return explicit || (ctx.viewport?.resourceKind === 'app' ? ctx.viewport.resourceId : '') || ctx.appId || '';
  };
  registry.registerMany([
    {
      definition: {
        id: 'agentis.app.doctor',
        family: 'inspect',
        description: 'Inspect an App as one executable system. Checks workflow dependencies, triggers and subscriptions, outcome contracts, connection/App bindings, conversation state references, and whether orchestration shown in the UI is backed by persisted rules. Read-only: returns structured findings and remediation operations; never claims to repair them.',
        inputSchema: {
          type: 'object',
          properties: { appId: { type: 'string', description: 'App id. Omit when an App is currently open.' } },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (or open the App first)');
        return validateAppConformance(collectAppDoctorSnapshot(deps.db, ctx.workspaceId, appId));
      },
    },
    {
      definition: {
        id: 'agentis.app.doctor.repair',
        family: 'build',
        description: 'Preview or apply deterministic App Doctor repairs. Only intent-preserving repairs are automated; findings requiring workflow, credential, channel, or UI choices remain explicit review_required items. Omit confirm:true for preview.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            findingIds: { type: 'array', items: { type: 'string' } },
            confirm: { type: 'boolean' },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (or open the App first)');
        return repairAppConformance(deps.db, ctx.workspaceId, appId, {
          dryRun: args.confirm !== true,
          findingIds: Array.isArray(args.findingIds) ? args.findingIds.map(String) : undefined,
        });
      },
    },
    {
      definition: {
        id: 'agentis.apps.conformance.migrate',
        family: 'build',
        description: 'Audit every existing App in the workspace against current orchestration contracts and preview/apply only deterministic safe migrations. Returns remaining blockers honestly; never invents missing business rules. Omit confirm:true for preview.',
        inputSchema: {
          type: 'object',
          properties: { appId: { type: 'string' }, confirm: { type: 'boolean' } },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => migrateWorkspaceAppConformance(deps.db, ctx.workspaceId, {
        dryRun: args.confirm !== true,
        appId: typeof args.appId === 'string' && args.appId.trim() ? args.appId.trim() : undefined,
      }),
    },
  ]);
}
