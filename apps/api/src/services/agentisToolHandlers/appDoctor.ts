/** Read-only agent tool for cross-layer App conformance inspection. */

import { AgentisError, appWorkflowBindingSchema } from '@agentis/core';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { collectAppDoctorSnapshot } from '../app/appDoctorSnapshot.js';
import { validateAppConformance } from '../app/appDoctor.js';
import { migrateWorkspaceAppConformance, repairAppConformance } from '../app/appDoctorRepair.js';
import { compileAppReadiness, type AppCompileTarget } from '../app/appCompiler.js';

export function registerAppDoctorTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const resolveAppId = (args: Record<string, unknown>, ctx: { viewport?: { resourceKind?: string; resourceId?: string } | null; appId?: string | null }): string => {
    const explicit = typeof args.appId === 'string' ? args.appId.trim() : '';
    return explicit || (ctx.viewport?.resourceKind === 'app' ? ctx.viewport.resourceId : '') || ctx.appId || '';
  };
  registry.registerMany([
    {
      definition: {
        id: 'agentis.app.compile',
        family: 'inspect',
        description:
          '[APP PRE-EXECUTION GATE] Compile an entire App into a deterministic readiness verdict BEFORE any costly or external run. '
          + 'Domain-neutral: validates strict workflow topology, executable activation/rules, definitions of done, current-graph dry-runs and test suites, runtime credentials/capabilities, channel resolution, closed-loop conversation enrollment/reachability, and surface operability. Separates structuralReady from executableReady. '
          + 'target:"debug" proves the zero-cost prerequisites for the first real debug run; "production" additionally reports current-graph accomplished debug evidence; "unattended" additionally reports hardening. Missing evidence keeps target readiness incomplete but never blocks the intentional manual run that creates it. '
          + 'Read-only. Defaults to compact blocker output. Apply compatible repairPlan.zeroCost steps as one batch, then compile once; never repair one blocker per model round.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App id. Omit when an App is currently open.' },
            target: { type: 'string', enum: ['debug', 'production', 'unattended'], description: 'Proof level. Default: debug.' },
            detail: { type: 'string', enum: ['summary', 'full'], description: 'Default summary returns blockers/warnings only. full includes every passing check.' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (or open the App first)');
        const target = typeof args.target === 'string' && ['debug', 'production', 'unattended'].includes(args.target)
          ? args.target as AppCompileTarget
          : 'debug';
        const report = compileAppReadiness(deps.db, ctx.workspaceId, appId, target);
        if (args.detail === 'full') return report;
        return {
          ...report,
          checks: report.checks.filter((check) => check.status === 'block' || check.status === 'warn'),
          compact: true,
          omittedPassingChecks: report.counts.pass,
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.verify',
        family: 'build',
        description: 'Run the free current-graph dry-run and pinned suite for every enabled workflow in an App as ONE batched tool call, then compile once. Use instead of calling workflow.dry_run/test repeatedly per workflow. Makes no external calls.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App id. Omit when an App is currently open.' },
            target: { type: 'string', enum: ['debug', 'production', 'unattended'], description: 'Compile target after verification. Default debug.' },
            dryRun: { type: 'boolean', description: 'Default true.' },
            suites: { type: 'boolean', description: 'Default true.' },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (or open the App first)');
        const rows = deps.db.select({ id: schema.workflows.id, title: schema.workflows.title, settings: schema.workflows.settings })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.workspaceId, ctx.workspaceId), eq(schema.workflows.appId, appId))).all()
          .filter((workflow) => {
            const settings = workflow.settings && typeof workflow.settings === 'object' ? workflow.settings as Record<string, unknown> : {};
            const binding = appWorkflowBindingSchema.safeParse(settings.appBinding ?? {});
            return !binding.success || binding.data.enabled !== false;
          });
        const runDry = args.dryRun !== false;
        const runSuites = args.suites !== false;
        const results = await Promise.all(rows.map(async (workflow) => {
          const dry = runDry ? await registry.execute({ id: '', toolId: 'agentis.workflow.dry_run', arguments: { workflowId: workflow.id } }, ctx) : null;
          const suite = runSuites ? await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: workflow.id, action: 'run' } }, ctx) : null;
          return {
            workflowId: workflow.id,
            title: workflow.title,
            dryRun: dry ? compactNestedResult(dry) : null,
            suite: suite ? compactNestedResult(suite) : null,
          };
        }));
        const target = typeof args.target === 'string' && ['debug', 'production', 'unattended'].includes(args.target)
          ? args.target as AppCompileTarget
          : 'debug';
        const compile = compileAppReadiness(deps.db, ctx.workspaceId, appId, target);
        return {
          appId,
          verifiedWorkflows: results.length,
          results,
          compile: {
            target,
            structuralReady: compile.structuralReady,
            executableReady: compile.executableReady,
            readyForExecution: compile.readyForExecution,
            executionBlockerCount: compile.executionBlockerCount,
            evidencePendingCount: compile.evidencePendingCount,
            counts: compile.counts,
            blockers: compile.checks.filter((check) => check.status === 'block' && check.blocksExecution !== false).map((check) => ({ id: check.id, summary: check.summary })),
            evidencePending: compile.checks.filter((check) => check.status === 'block' && check.blocksExecution === false).map((check) => ({ id: check.id, summary: check.summary })),
            repairPlan: compile.repairPlan,
          },
          summary: `Verified ${results.length} workflow(s) in one zero-external-call batch; compile has ${compile.executionBlockerCount} execution blocker(s) and ${compile.evidencePendingCount} pending evidence gate(s).`,
        };
      },
    },
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

function compactNestedResult(result: Awaited<ReturnType<AgentisToolRegistry['execute']>>): Record<string, unknown> {
  if (!result.ok) return { ok: false, code: result.errorCode, error: result.errorMessage };
  const output = result.output && typeof result.output === 'object' ? result.output as Record<string, unknown> : {};
  return {
    ok: output.ok !== false,
    ...(typeof output.status === 'string' ? { status: output.status } : {}),
    ...(typeof output.total === 'number' ? { total: output.total } : {}),
    ...(typeof output.gating === 'number' ? { gating: output.gating } : {}),
    ...(typeof output.passed === 'number' ? { passed: output.passed } : {}),
    ...(typeof output.summary === 'string' ? { summary: output.summary } : {}),
  };
}
