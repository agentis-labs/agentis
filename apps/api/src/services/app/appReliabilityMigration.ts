import { and, eq } from 'drizzle-orm';
import {
  schemas,
  type ExtensionTaskNodeConfig,
  type WorkflowGraph,
  type WorkflowRunState,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { compileAppReadiness } from './appCompiler.js';
import { migrateWorkspaceAppConformance } from './appDoctorRepair.js';
import { readWorkflowSpec, validateWorkflowSpec } from '../workflow/workflowSpec.js';
import { generateEdgeCases, readWorkflowTests } from '../workflow/workflowTestGenerator.js';
import type { WorkflowRevisionService } from '../workflow/workflowRevisionService.js';

export type AppReliabilityFindingSeverity = 'block' | 'review' | 'info';

export interface AppReliabilityFinding {
  code: string;
  severity: AppReliabilityFindingSeverity;
  appId: string;
  workflowId?: string;
  revisionId?: string;
  autoFixable: boolean;
  message: string;
  remediation?: { tool: string; args: Record<string, unknown> };
}

export interface AppReliabilityMigrationResult {
  committed: boolean;
  apps: Array<{
    appId: string;
    name: string;
    findings: AppReliabilityFinding[];
    applied: string[];
    compile: { ready: boolean; blockerCount: number; blockers: Array<{ id: string; summary: string }> };
  }>;
  totals: {
    scannedApps: number;
    scannedWorkflows: number;
    findings: number;
    automatic: number;
    applied: number;
    reviewRequired: number;
    productionReady: number;
  };
}

/**
 * Fleet reliability upgrade for existing Apps. It repairs only facts that can
 * be derived without business judgement: invalid historic clean proofs,
 * legacy mutation syntax, mechanical input-contract fixtures and App Doctor's
 * existing intent-preserving conformance fixes. Missing success contracts,
 * worldly probes and extension schemas stay visible review items.
 */
export function migrateWorkspaceAppReliability(
  db: AgentisSqliteDb,
  revisions: WorkflowRevisionService,
  workspaceId: string,
  options: { dryRun?: boolean; appId?: string } = {},
): AppReliabilityMigrationResult {
  const commit = options.dryRun === false;
  const appRows = options.appId
    ? db.select({ id: schema.apps.id, name: schema.apps.name }).from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, options.appId))).all()
    : db.select({ id: schema.apps.id, name: schema.apps.name }).from(schema.apps)
      .where(eq(schema.apps.workspaceId, workspaceId)).all();

  const apps = appRows.map((app) => {
    const findings: AppReliabilityFinding[] = [];
    const applied: string[] = [];
    const workflows = db.select().from(schema.workflows).where(and(
      eq(schema.workflows.workspaceId, workspaceId),
      eq(schema.workflows.appId, app.id),
    )).all();

    const conformance = migrateWorkspaceAppConformance(db, workspaceId, { dryRun: !commit, appId: app.id });
    const repairedConformance = conformance.apps[0];
    if (commit && repairedConformance?.applied.length) {
      applied.push(...repairedConformance.applied.map((id) => `conformance:${id}`));
    }
    for (const skipped of repairedConformance?.skipped ?? []) {
      findings.push({
        code: 'APP_CONFORMANCE_REVIEW_REQUIRED',
        severity: 'review',
        appId: app.id,
        autoFixable: false,
        message: skipped.reason,
        remediation: { tool: 'agentis.app.doctor', args: { appId: app.id } },
      });
    }

    for (const workflow of workflows) {
      const headRevision = workflow.candidateRevisionId
        ? db.select().from(schema.workflowGraphRevisions).where(and(
          eq(schema.workflowGraphRevisions.workspaceId, workspaceId),
          eq(schema.workflowGraphRevisions.workflowId, workflow.id),
          eq(schema.workflowGraphRevisions.id, workflow.candidateRevisionId),
        )).get()
        : workflow.activeRevisionId
          ? db.select().from(schema.workflowGraphRevisions).where(and(
            eq(schema.workflowGraphRevisions.workspaceId, workspaceId),
            eq(schema.workflowGraphRevisions.workflowId, workflow.id),
            eq(schema.workflowGraphRevisions.id, workflow.activeRevisionId),
          )).get()
          : null;
      const graph = (headRevision?.graphJson ?? workflow.graph) as WorkflowGraph;
      const settings = record(workflow.settings);
      const spec = readWorkflowSpec(settings);
      const specErrors = spec ? validateWorkflowSpec(spec, { graph }) : [];

      if (!workflow.activeRevisionId || workflow.trustState === 'legacy_unverified') {
        const recoverableLegacy = !workflow.appId && hasCleanAccomplishedSnapshot(db, workspaceId, workflow.id);
        findings.push({
          code: 'LEGACY_REVISION_UNVERIFIED', severity: 'block', appId: app.id, workflowId: workflow.id,
          revisionId: workflow.activeRevisionId ?? undefined, autoFixable: recoverableLegacy,
          message: recoverableLegacy
            ? 'Standalone workflow has legacy proof state, but a clean accomplished snapshot can be reconciled deterministically.'
            : 'App-owned or unproven workflow requires agentis.app.deliver to establish current immutable proof.',
          remediation: { tool: 'agentis.app.deliver', args: { appId: app.id } },
        });
        if (commit && recoverableLegacy) {
          const reconciled = revisions.reconcileLegacyWorkflow(workspaceId, workflow.id);
          if (reconciled.changed) applied.push(`legacy-proof:${workflow.id}`);
        }
      }

      invalidateDirtyCleanProofs(db, workspaceId, app.id, workflow.id, commit, findings, applied);

      const normalizedGraph = normalizeLegacyMutationGraph(graph);
      if (normalizedGraph.changed) {
        findings.push({
          code: 'LEGACY_DATA_MUTATION_SYNTAX', severity: 'block', appId: app.id, workflowId: workflow.id,
          revisionId: headRevision?.id, autoFixable: true,
          message: `Normalize ${normalizedGraph.count} legacy data_mutate node(s) into the globally validated batch contract.`,
          remediation: { tool: 'agentis.app.deliver', args: { appId: app.id } },
        });
        if (commit) {
          const ensured = revisions.ensureWorkflow(workspaceId, workflow.id);
          const baseRevisionId = workflow.candidateRevisionId ?? ensured.active.id;
          const candidate = revisions.createCandidate({
            workspaceId,
            workflowId: workflow.id,
            graph: normalizedGraph.graph,
            baseRevisionId,
            source: 'migration',
            actor: { type: 'system', id: 'app-reliability-migration' },
            reason: 'Normalize legacy data_mutate syntax; publication remains gated by agentis.app.deliver.',
          });
          if (!candidate.unchanged) applied.push(`mutation-contract:${workflow.id}:${candidate.revision.id}`);
        }
      }

      const tests = readWorkflowTests(settings);
      const generated = generateEdgeCases(graph);
      const hasHappy = tests.some((test) => test.kind === 'happy');
      const hasNonHappy = tests.some((test) => test.kind !== 'happy');
      if ((!hasHappy || !hasNonHappy) && generated.length > 0) {
        findings.push({
          code: 'MECHANICAL_TEST_BATTERY_MISSING', severity: 'block', appId: app.id, workflowId: workflow.id,
          autoFixable: true,
          message: 'Input contract can deterministically generate happy and adverse fixtures; generated cases remain non-gating until reviewed.',
          remediation: { tool: 'agentis.workflow.test', args: { workflowId: workflow.id, action: 'generate' } },
        });
        if (commit) {
          const existingKeys = new Set(tests.map((test) => `${test.kind}:${test.name}`));
          const additions = generated.filter((test) => !existingKeys.has(`${test.kind}:${test.name}`));
          if (additions.length > 0) {
            db.update(schema.workflows).set({
              settings: { ...settings, workflowTests: [...tests, ...additions] },
              updatedAt: new Date().toISOString(),
            }).where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflow.id))).run();
            applied.push(`test-battery:${workflow.id}:${additions.length}`);
          }
        }
      }

      const outputFields = (graph as { outputContract?: { fields?: unknown[] } }).outputContract?.fields;
      if (!Array.isArray(outputFields) || outputFields.length === 0) {
        findings.push(reviewFinding(app.id, workflow.id, 'OUTPUT_CONTRACT_MISSING', 'Declare the workflow output fields; Agentis cannot infer business output semantics safely.'));
      }
      if (!spec || specErrors.length > 0) {
        findings.push(reviewFinding(app.id, workflow.id, 'DEFINITION_OF_DONE_MISSING', spec
          ? `Definition of done is invalid: ${specErrors.slice(0, 3).join('; ')}`
          : 'Define how this workflow proves accomplishment.'));
      } else if (!spec.acceptance.some((check) => check.verify !== 'judge')) {
        findings.push(reviewFinding(app.id, workflow.id, 'WORLDLY_PROOF_MISSING', 'Add an authoritative expr, HTTP or datastore proof; judge-only success cannot publish an App.'));
      }
      if (graph.nodes.some((node) => node.config.kind === 'data_mutate')
        && !spec?.acceptance.some((check) => check.verify === 'data_probe' && check.integration === 'agentis_app')) {
        findings.push(reviewFinding(app.id, workflow.id, 'DATASTORE_PROBE_MISSING', 'This workflow mutates App data but does not verify the persisted result through an agentis_app data probe.'));
      }
      findings.push(...extensionSchemaFindings(db, workspaceId, app.id, workflow.id, graph));
    }

    const compile = compileAppReadiness(db, workspaceId, app.id, 'production');
    return {
      appId: app.id,
      name: app.name,
      findings,
      applied,
      compile: {
        ready: compile.ready,
        blockerCount: compile.checks.filter((check) => check.status === 'block').length,
        blockers: compile.checks.filter((check) => check.status === 'block').slice(0, 30)
          .map((check) => ({ id: check.id, summary: check.summary })),
      },
    };
  });

  const allFindings = apps.flatMap((app) => app.findings);
  return {
    committed: commit,
    apps,
    totals: {
      scannedApps: apps.length,
      scannedWorkflows: appRows.reduce((sum, app) => sum + db.select({ id: schema.workflows.id }).from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, app.id))).all().length, 0),
      findings: allFindings.length,
      automatic: allFindings.filter((finding) => finding.autoFixable).length,
      applied: apps.reduce((sum, app) => sum + app.applied.length, 0),
      reviewRequired: allFindings.filter((finding) => !finding.autoFixable).length,
      productionReady: apps.filter((app) => app.compile.ready).length,
    },
  };
}

function hasCleanAccomplishedSnapshot(db: AgentisSqliteDb, workspaceId: string, workflowId: string): boolean {
  return db.select({
    status: schema.workflowRuns.status,
    runState: schema.workflowRuns.runState,
    graphSnapshot: schema.workflowRuns.graphSnapshot,
  }).from(schema.workflowRuns).where(and(
    eq(schema.workflowRuns.workspaceId, workspaceId),
    eq(schema.workflowRuns.workflowId, workflowId),
  )).all().some((run) => {
    const verdict = (run.runState as WorkflowRunState & { verdict?: { outcome?: string } } | null)?.verdict;
    return run.status === 'COMPLETED' && Boolean(run.graphSnapshot) && verdict?.outcome === 'accomplished';
  });
}

function invalidateDirtyCleanProofs(
  db: AgentisSqliteDb,
  workspaceId: string,
  appId: string,
  workflowId: string,
  commit: boolean,
  findings: AppReliabilityFinding[],
  applied: string[],
): void {
  const proofs = db.select().from(schema.workflowRevisionProofs).where(and(
    eq(schema.workflowRevisionProofs.workspaceId, workspaceId),
    eq(schema.workflowRevisionProofs.workflowId, workflowId),
    eq(schema.workflowRevisionProofs.gate, 'clean_debug'),
    eq(schema.workflowRevisionProofs.status, 'passed'),
  )).all();
  for (const proof of proofs) {
    const run = proof.runId ? db.select({
      status: schema.workflowRuns.status,
      workflowRevisionId: schema.workflowRuns.workflowRevisionId,
      runState: schema.workflowRuns.runState,
    }).from(schema.workflowRuns).where(and(
      eq(schema.workflowRuns.workspaceId, workspaceId),
      eq(schema.workflowRuns.id, proof.runId),
    )).get() : null;
    const verdict = (run?.runState as WorkflowRunState & { verdict?: { outcome?: string } } | null)?.verdict;
    if (run?.status === 'COMPLETED' && run.workflowRevisionId === proof.revisionId && verdict?.outcome === 'accomplished') continue;
    findings.push({
      code: 'DIRTY_CLEAN_PROOF', severity: 'block', appId, workflowId, revisionId: proof.revisionId,
      autoFixable: true,
      message: `Historic clean_debug proof ${proof.id} is not backed by a clean accomplished run of the same revision.`,
      remediation: { tool: 'agentis.app.deliver', args: { appId } },
    });
    if (!commit) continue;
    const now = new Date().toISOString();
    db.transaction(() => {
      db.update(schema.workflowRevisionProofs).set({
        status: 'failed',
        evidenceJson: { previous: proof.evidenceJson, invalidatedBy: 'app_reliability_migration', runStatus: run?.status ?? 'missing' },
        updatedAt: now,
      }).where(eq(schema.workflowRevisionProofs.id, proof.id)).run();
      const workflow = db.select({ activeRevisionId: schema.workflows.activeRevisionId }).from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId))).get();
      if (workflow?.activeRevisionId === proof.revisionId) {
        db.update(schema.workflows).set({ trustState: 'regressed', updatedAt: now })
          .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId))).run();
        db.update(schema.workflowGraphRevisions).set({ trustState: 'regressed', updatedAt: now })
          .where(eq(schema.workflowGraphRevisions.id, proof.revisionId)).run();
      }
    });
    applied.push(`invalidate-proof:${proof.id}`);
  }
}

function normalizeLegacyMutationGraph(graph: WorkflowGraph): { graph: WorkflowGraph; changed: boolean; count: number } {
  let count = 0;
  const nodes = graph.nodes.map((node) => {
    if (node.config.kind !== 'data_mutate') return node;
    const raw = node.config as unknown as Record<string, unknown>;
    const legacy = raw.operation === 'insert_many' || raw.operation === 'upsert_many'
      || (typeof raw.matchKey === 'string' && raw.matchFields === undefined);
    if (!legacy) return node;
    count += 1;
    return { ...node, config: schemas.normalizeLegacyDataMutateConfig(raw) as typeof node.config };
  });
  return { graph: count > 0 ? { ...graph, nodes } : graph, changed: count > 0, count };
}

function extensionSchemaFindings(
  db: AgentisSqliteDb,
  workspaceId: string,
  appId: string,
  workflowId: string,
  graph: WorkflowGraph,
): AppReliabilityFinding[] {
  const extensions = db.select().from(schema.extensions).where(eq(schema.extensions.workspaceId, workspaceId)).all();
  return graph.nodes.flatMap((node) => {
    if (node.config.kind !== 'extension_task') return [];
    const config = node.config as ExtensionTaskNodeConfig;
    const extension = extensions.find((row) => row.id === config.extensionId || row.slug === config.extensionSlug);
    const manifest = record(extension?.manifest);
    const operations = Array.isArray(manifest.operations) ? manifest.operations.filter(isRecord) : [];
    const operation = operations.find((candidate) => candidate.name === config.operationName);
    const outputSchema = operation ? record(operation.outputSchema) : {};
    if (extension && Object.keys(outputSchema).length > 0) return [];
    return [reviewFinding(appId, workflowId, 'EXTENSION_OUTPUT_SCHEMA_MISSING', extension
      ? `Extension ${extension.slug}/${config.operationName} has no declared output schema; preflight cannot model production output authoritatively.`
      : `Extension binding for node ${node.id} cannot be resolved in this workspace.`)];
  });
}

function reviewFinding(appId: string, workflowId: string, code: string, message: string): AppReliabilityFinding {
  return {
    code, severity: 'review', appId, workflowId, autoFixable: false, message,
    remediation: { tool: 'agentis.app.deliver', args: { appId } },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
