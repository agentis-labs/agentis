import { and, eq } from 'drizzle-orm';
import { appWorkflowBindingSchema, type AppWorkflowBinding, type WorkflowGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { collectAppDoctorSnapshot } from './appDoctorSnapshot.js';
import { validateAppConformance, type AppDoctorFinding, type AppDoctorReport } from './appDoctor.js';
import { readWorkflowSpec, validateWorkflowSpec } from '../workflow/workflowSpec.js';

export type AppDoctorRepairSafety = 'safe' | 'review_required';

export interface AppDoctorRepairAction {
  findingId: string;
  code: string;
  safety: AppDoctorRepairSafety;
  description: string;
  mutation?: Record<string, unknown>;
  reason?: string;
}

export interface AppDoctorRepairResult {
  appId: string;
  committed: boolean;
  before: AppDoctorReport['summary'];
  after: AppDoctorReport['summary'];
  actions: AppDoctorRepairAction[];
  applied: string[];
  skipped: Array<{ findingId: string; reason: string }>;
  report: AppDoctorReport;
}

/**
 * Deterministic Doctor repair executor. It deliberately auto-applies only
 * changes whose intent is provably preserved. Findings that require choosing a
 * workflow, channel, acceptance contract, or dependency edge remain explicit
 * review items instead of being guessed by an agent.
 */
export function repairAppConformance(
  db: AgentisSqliteDb,
  workspaceId: string,
  appId: string,
  options: { dryRun?: boolean; findingIds?: string[] } = {},
): AppDoctorRepairResult {
  const beforeReport = validateAppConformance(collectAppDoctorSnapshot(db, workspaceId, appId));
  const selected = options.findingIds?.length
    ? beforeReport.findings.filter((finding) => options.findingIds!.includes(finding.id))
    : beforeReport.findings;
  const actions = selected.map((finding) => planRepair(db, workspaceId, appId, finding));
  const applied: string[] = [];
  const skipped: Array<{ findingId: string; reason: string }> = [];

  for (const action of actions) {
    if (action.safety !== 'safe') {
      skipped.push({ findingId: action.findingId, reason: action.reason ?? 'Operator review is required.' });
      continue;
    }
    if (options.dryRun !== false) continue;
    applyRepair(db, workspaceId, action);
    applied.push(action.findingId);
  }

  const report = options.dryRun === false
    ? validateAppConformance(collectAppDoctorSnapshot(db, workspaceId, appId))
    : beforeReport;
  return {
    appId,
    committed: options.dryRun === false,
    before: beforeReport.summary,
    after: report.summary,
    actions,
    applied,
    skipped,
    report,
  };
}

export function migrateWorkspaceAppConformance(
  db: AgentisSqliteDb,
  workspaceId: string,
  options: { dryRun?: boolean; appId?: string } = {},
): { committed: boolean; apps: AppDoctorRepairResult[]; totals: { scanned: number; applied: number; remainingCritical: number; remainingErrors: number } } {
  const rows = options.appId
    ? db.select({ id: schema.apps.id }).from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, options.appId))).all()
    : db.select({ id: schema.apps.id }).from(schema.apps).where(eq(schema.apps.workspaceId, workspaceId)).all();
  const apps = rows.map((row) => repairAppConformance(db, workspaceId, row.id, { dryRun: options.dryRun }));
  return {
    committed: options.dryRun === false,
    apps,
    totals: {
      scanned: apps.length,
      applied: apps.reduce((sum, app) => sum + app.applied.length, 0),
      remainingCritical: apps.reduce((sum, app) => sum + app.report.summary.critical, 0),
      remainingErrors: apps.reduce((sum, app) => sum + app.report.summary.error, 0),
    },
  };
}

function planRepair(
  db: AgentisSqliteDb,
  workspaceId: string,
  appId: string,
  finding: AppDoctorFinding,
): AppDoctorRepairAction {
  const args = finding.remediation.args ?? {};
  if (finding.code === 'BINDING_SELF_DEPENDENCY' || finding.code === 'BINDING_DEPENDENCY_OUTSIDE_APP') {
    const workflowId = String(args.workflowId ?? finding.resources.find((item) => item.kind === 'workflow')?.id ?? '');
    const dependencyId = String(args.dependencyId ?? finding.evidence.dependencyId ?? workflowId);
    return {
      findingId: finding.id, code: finding.code, safety: 'safe',
      description: 'Remove the invalid dependency while preserving every other App binding field.',
      mutation: { kind: 'workflow_binding_remove_dependency', workflowId, dependencyId },
    };
  }
  if (finding.code === 'EVENT_SUBSCRIPTION_SOURCE_NODE_MISSING') {
    const subscriptionId = finding.resources.find((item) => item.kind === 'subscription')?.id ?? String(args.subscriptionId ?? '');
    return {
      findingId: finding.id, code: finding.code, safety: 'safe',
      description: 'Remove the stale source-node filter; the workflow-level event rule remains intact.',
      mutation: { kind: 'subscription_clear_source_node', subscriptionId },
    };
  }
  if (finding.code === 'OUTCOME_EVENT_USES_COMPLETION') {
    const subscriptionId = finding.resources.find((item) => item.kind === 'subscription')?.id ?? String(args.subscriptionId ?? '');
    const subscription = db.select().from(schema.workflowEventSubscriptions)
      .where(and(eq(schema.workflowEventSubscriptions.workspaceId, workspaceId), eq(schema.workflowEventSubscriptions.id, subscriptionId))).get();
    const source = subscription
      ? db.select({ graph: schema.workflows.graph, settings: schema.workflows.settings, appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, subscription.sourceWorkflowId))).get()
      : null;
    const spec = source ? readWorkflowSpec(source.settings) : null;
    if (subscription && source?.appId === appId && spec && validateWorkflowSpec(spec, { graph: source.graph as WorkflowGraph }).length === 0) {
      return {
        findingId: finding.id, code: finding.code, safety: 'safe',
        description: 'Gate progression on run.accomplished because the source has a valid executable definition of done.',
        mutation: { kind: 'subscription_use_accomplished', subscriptionId },
      };
    }
    return review(finding, 'Define and validate the source workflow success contract before changing completion semantics.');
  }
  return review(finding, 'This repair requires intent, credential, workflow, or UI choices that Agentis cannot infer safely.');
}

function applyRepair(db: AgentisSqliteDb, workspaceId: string, action: AppDoctorRepairAction): void {
  const mutation = action.mutation ?? {};
  if (mutation.kind === 'workflow_binding_remove_dependency') {
    const workflowId = String(mutation.workflowId);
    const dependencyId = String(mutation.dependencyId);
    const workflow = db.select({ settings: schema.workflows.settings }).from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId))).get();
    if (!workflow) return;
    const settings = record(workflow.settings);
    const parsed = appWorkflowBindingSchema.safeParse(settings.appBinding ?? {});
    if (!parsed.success) return;
    const binding: AppWorkflowBinding = { ...parsed.data, dependsOn: parsed.data.dependsOn.filter((id) => id !== dependencyId) };
    db.update(schema.workflows).set({ settings: { ...settings, appBinding: binding }, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId))).run();
    return;
  }
  if (mutation.kind === 'subscription_clear_source_node') {
    db.update(schema.workflowEventSubscriptions).set({ sourceNodeId: null, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.workflowEventSubscriptions.workspaceId, workspaceId), eq(schema.workflowEventSubscriptions.id, String(mutation.subscriptionId)))).run();
    return;
  }
  if (mutation.kind === 'subscription_use_accomplished') {
    db.update(schema.workflowEventSubscriptions).set({ eventType: 'run.accomplished', updatedAt: new Date().toISOString() })
      .where(and(eq(schema.workflowEventSubscriptions.workspaceId, workspaceId), eq(schema.workflowEventSubscriptions.id, String(mutation.subscriptionId)))).run();
  }
}

function review(finding: AppDoctorFinding, reason: string): AppDoctorRepairAction {
  return {
    findingId: finding.id,
    code: finding.code,
    safety: 'review_required',
    description: finding.remediation.description,
    reason,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
