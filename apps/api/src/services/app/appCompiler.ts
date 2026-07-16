/**
 * App compiler -- a zero-side-effect, domain-neutral pre-execution gate.
 *
 * App Doctor answers whether persisted layers agree. The compiler goes one step
 * further: it joins that conformance report with every workflow's current-graph
 * proof, runtime prerequisites, channel resolution, and surface operability.
 * This is deliberately deterministic and read-only so an agent can call it
 * before spending money or touching the outside world.
 */

import { and, desc, eq } from 'drizzle-orm';
import {
  appWorkflowBindingSchema,
  conversationScriptSchema,
  repairSurface,
  summarizeGraphCapabilities,
  workflowContractFields,
  viewNodeSchema,
  type WorkflowGraph,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { validateWorkflowGraph } from '../../engine/validateGraph.js';
import { validateAppConformance, type AppDoctorFinding } from './appDoctor.js';
import { collectAppDoctorSnapshot } from './appDoctorSnapshot.js';
import { analyzeWorkflowReadiness } from '../workflow/workflowReadiness.js';
import { graphContentHash, readBuildLoop } from '../workflow/workflowCompass.js';
import { readWorkflowSpec } from '../workflow/workflowSpec.js';
import { readWorkflowTests } from '../workflow/workflowTestGenerator.js';

export type AppCompileTarget = 'debug' | 'production' | 'unattended';
export type AppCompileStatus = 'pass' | 'block' | 'warn' | 'not_applicable';
export type AppCompileLayer = 'topology' | 'activation' | 'outcome' | 'runtime' | 'channel' | 'surface' | 'test';

export interface AppCompileAction {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  safety?: {
    externalEffectsPossible: boolean;
    requiresOperatorApproval: boolean;
    reason: string;
  };
}

export interface AppCompileCheck {
  id: string;
  layer: AppCompileLayer;
  status: AppCompileStatus;
  summary: string;
  workflowId?: string;
  evidence?: Record<string, unknown>;
  clearWith?: AppCompileAction;
  /** False for evidence/release gates that must not prevent the run that creates the evidence. */
  blocksExecution?: boolean;
}

export interface AppCompileReport {
  appId: string;
  target: AppCompileTarget;
  generatedAt: string;
  /** Persisted structure is internally coherent; this alone does not mean it can progress. */
  structuralReady: boolean;
  /** Runtime identity, resources, and proof are present for the requested target. */
  executableReady: boolean;
  ready: boolean;
  /** True means the first costly/world-touching run is allowed by this proof. */
  readyForExecution: boolean;
  /** Hard blockers that must be cleared before any run can start. */
  executionBlockerCount: number;
  /** Target evidence/hardening still required, but never a reason to block a manual proof run. */
  evidencePendingCount: number;
  counts: Record<AppCompileStatus, number>;
  checks: AppCompileCheck[];
  workflowProofs: Array<{
    workflowId: string;
    title: string;
    graphHash: string;
    enabled: boolean;
    dryRunGreen: boolean;
    suiteGreen: boolean;
    debugAccomplished: boolean;
    hardened: boolean;
  }>;
  next: AppCompileAction[];
  /** Batch-oriented execution plan. Zero-cost repairs should be applied together, then compiled once. */
  repairPlan: {
    zeroCost: AppCompileAction[];
    liveProof: AppCompileAction[];
  };
  summary: string;
}

/** Compile the current persisted App into a readiness verdict without executing it. */
export function compileAppReadiness(
  db: AgentisSqliteDb,
  workspaceId: string,
  appId: string,
  target: AppCompileTarget = 'debug',
  now = new Date(),
): AppCompileReport {
  const snapshot = collectAppDoctorSnapshot(db, workspaceId, appId);
  const doctor = validateAppConformance(snapshot, now);
  const checks: AppCompileCheck[] = doctor.findings.map(doctorCheck);
  const workflowProofs: AppCompileReport['workflowProofs'] = [];

  if (snapshot.workflows.length === 0) {
    checks.push({
      id: 'app:no-workflows', layer: 'topology', status: 'block',
      summary: 'The App has no workflow to execute.',
      clearWith: { tool: 'agentis.build_workflow', args: { appId }, why: 'Author at least one executable workflow inside the App.' },
    });
  }

  for (const workflow of snapshot.workflows) {
    const binding = appWorkflowBindingSchema.safeParse(record(workflow.settings)?.appBinding ?? {}).success
      ? appWorkflowBindingSchema.parse(record(workflow.settings)?.appBinding ?? {})
      : appWorkflowBindingSchema.parse({});
    const enabled = binding.enabled !== false;
    const graph = workflow.graph as WorkflowGraph;
    const capabilitySummary = summarizeGraphCapabilities(graph);
    const externalEffectsPossible = capabilitySummary.hasUnrestrictedNetwork
      || capabilitySummary.sendsDataExternally
      || capabilitySummary.writesFilesystem
      || capabilitySummary.runsCode
      || capabilitySummary.unknownNodeKinds.length > 0;
    const externalEffectReasons = [
      capabilitySummary.hasUnrestrictedNetwork ? 'unrestricted network-capable nodes' : '',
      capabilitySummary.sendsDataExternally ? 'data may leave the instance' : '',
      capabilitySummary.writesFilesystem ? 'workspace filesystem writes' : '',
      capabilitySummary.runsCode ? 'code execution' : '',
      capabilitySummary.unknownNodeKinds.length > 0
        ? `unclassified node kinds (${capabilitySummary.unknownNodeKinds.join(', ')})`
        : '',
    ].filter(Boolean);
    const hash = graphContentHash(graph);
    const loop = readBuildLoop(workflow.settings);
    const dryRunGreen = Boolean(loop.dryRun?.graphHash === hash && loop.dryRun.ok);
    const suiteGreen = Boolean(loop.suite?.graphHash === hash && loop.suite.ok);
    const debugAccomplished = Boolean(
      loop.debugRun?.graphHash === hash
      && (loop.debugRun.status === 'COMPLETED' || loop.debugRun.status === 'COMPLETED_WITH_CONTRACT_VIOLATION')
      && loop.debugRun.verdict === 'accomplished',
    );
    const hardened = Boolean(loop.hardened?.graphHash === hash);
    workflowProofs.push({ workflowId: workflow.id, title: workflow.title, graphHash: hash, enabled, dryRunGreen, suiteGreen, debugAccomplished, hardened });
    if (!enabled) continue;

    try {
      validateWorkflowGraph(graph, { currentWorkflowId: workflow.id, strict: true });
      checks.push({ id: `graph:${workflow.id}`, layer: 'topology', status: 'pass', workflowId: workflow.id, summary: `Workflow "${workflow.title}" has an executable graph.` });
    } catch (error) {
      checks.push({
        id: `graph:${workflow.id}`, layer: 'topology', status: 'block', workflowId: workflow.id,
        summary: `Workflow "${workflow.title}" does not pass strict graph validation.`,
        evidence: { error: (error as Error).message },
        clearWith: { tool: 'agentis.build_workflow', args: { workflowId: workflow.id, description: 'repair the strict graph validation error', patchDraft: { updateNodes: [] } }, why: 'Repair the named graph contract before any execution.' },
      });
    }

    const runtime = analyzeWorkflowReadiness(db, workspaceId, graph);
    checks.push(runtime.ready
      ? { id: `runtime:${workflow.id}`, layer: 'runtime', status: 'pass', workflowId: workflow.id, summary: `Workflow "${workflow.title}" has its required runtime capabilities and credentials.` }
      : {
          id: `runtime:${workflow.id}`, layer: 'runtime', status: 'block', workflowId: workflow.id,
          summary: runtime.summary, evidence: { requirements: runtime.requirements },
          clearWith: { tool: 'agentis.workflow.loop_status', args: { workflowId: workflow.id }, why: 'Resolve the concrete credential/configuration requirements before a real run.' },
        });

    const spec = readWorkflowSpec(workflow.settings);
    checks.push(spec
      ? { id: `spec:${workflow.id}`, layer: 'outcome', status: 'pass', workflowId: workflow.id, summary: `Workflow "${workflow.title}" has a definition of done.` }
      : {
          id: `spec:${workflow.id}`, layer: 'outcome', status: 'block', workflowId: workflow.id,
          summary: `Workflow "${workflow.title}" has no definition of done, so a completed run cannot prove success.`,
          clearWith: { tool: 'agentis.workflow.scope', args: { workflowId: workflow.id }, why: 'Define executable acceptance checks before testing the workflow.' },
        });
    if (spec) {
      const declared = new Set(workflowContractFields(graph.outputContract).map((field) => field.key));
      const referenced = new Set<string>();
      for (const check of spec.acceptance) {
        const sources = [
          check.verify === 'expr' || check.verify === 'data_probe' ? check.expr : '',
          check.verify === 'http_probe' || check.verify === 'browser_probe' ? check.url : '',
          check.verify === 'file_probe' ? check.path : '',
        ];
        for (const source of sources) {
          for (const match of source.matchAll(/(?:\{|\b)output\.([A-Za-z_$][\w$]*)/gu)) referenced.add(match[1]!);
        }
      }
      for (const floor of spec.sufficiency ?? []) referenced.add(floor.key.split('.')[0]!);
      const missing = [...referenced].filter((key) => !declared.has(key));
      checks.push(referenced.size > 0 && declared.size === 0
        ? {
            id: `output-contract:${workflow.id}`, layer: 'outcome', status: 'block', workflowId: workflow.id,
            summary: `Workflow "${workflow.title}" grades terminal output paths but declares no output contract, so path correctness cannot be compiled before a live run.`,
            evidence: { referencedTopLevelPaths: [...referenced] },
            clearWith: { tool: 'agentis.build_workflow', args: { workflowId: workflow.id, description: 'declare the terminal outputContract and align the return/output node with the definition of done' }, why: 'Make the terminal data shape explicit so acceptance paths are statically checked instead of guessed after side effects.' },
          }
        : missing.length > 0
          ? {
              id: `output-contract:${workflow.id}`, layer: 'outcome', status: 'block', workflowId: workflow.id,
              summary: `Workflow "${workflow.title}" has definition-of-done paths that are absent from its declared terminal output contract.`,
              evidence: { missingTopLevelPaths: missing, declaredTopLevelPaths: [...declared] },
              clearWith: { tool: 'agentis.workflow.scope', args: { workflowId: workflow.id }, why: 'Align acceptance expressions with the canonical terminal output contract before any real run.' },
            }
          : { id: `output-contract:${workflow.id}`, layer: 'outcome', status: 'pass', workflowId: workflow.id, summary: `Workflow "${workflow.title}" acceptance paths align with its declared terminal output contract.` });
    }

    checks.push(dryRunGreen
      ? { id: `dry-run:${workflow.id}`, layer: 'test', status: 'pass', workflowId: workflow.id, summary: `Workflow "${workflow.title}" has a green zero-cost dry-run at the current graph.` }
      : {
          id: `dry-run:${workflow.id}`, layer: 'test', status: 'block', workflowId: workflow.id,
          summary: `Workflow "${workflow.title}" has no green dry-run evidence for its current graph.`,
          clearWith: { tool: 'agentis.workflow.dry_run', args: { workflowId: workflow.id }, why: 'Prove deterministic data flow before paying for a debug run.' },
        });

    const authoredCases = readWorkflowTests(workflow.settings).filter((testCase) => testCase.origin !== 'generated');
    const hasHappy = authoredCases.some((testCase) => testCase.kind === 'happy');
    const hasNonHappy = authoredCases.some((testCase) => testCase.kind !== 'happy');
    checks.push(suiteGreen && hasHappy && hasNonHappy
      ? { id: `suite:${workflow.id}`, layer: 'test', status: 'pass', workflowId: workflow.id, summary: `Workflow "${workflow.title}" has a green current-graph suite with happy and non-happy coverage.` }
      : {
          id: `suite:${workflow.id}`, layer: 'test', status: 'block', workflowId: workflow.id,
          summary: `Workflow "${workflow.title}" lacks a green current-graph suite with at least one happy and one non-happy case.`,
          evidence: { suiteGreen, authoredCases: authoredCases.length, hasHappy, hasNonHappy },
          clearWith: { tool: 'agentis.workflow.test', args: { workflowId: workflow.id, action: authoredCases.length === 0 ? 'generate' : 'run' }, why: 'Build and run the free regression battery before real execution.' },
        });

    if (target !== 'debug') {
      checks.push(debugAccomplished
        ? { id: `debug-proof:${workflow.id}`, layer: 'test', status: 'pass', workflowId: workflow.id, summary: `Workflow "${workflow.title}" has a current-graph debug run proven accomplished.` }
        : {
            id: `debug-proof:${workflow.id}`, layer: 'test', status: 'block', workflowId: workflow.id,
            blocksExecution: false,
            summary: `Workflow "${workflow.title}" has not proven real-world accomplishment at its current graph.`,
            clearWith: {
              tool: 'agentis.workflow.run',
              args: { workflowId: workflow.id, debugRun: true },
              why: externalEffectsPossible
                ? 'Run one raw debug execution only after the zero-cost gates are green and the operator has approved its possible external effects. The run defaults to the latest same-graph failed frontier; do not force a fresh root run.'
                : 'Run one raw debug execution only after the zero-cost compile gates are green. The run defaults to the latest same-graph failed frontier; do not force a fresh root run.',
              safety: {
                externalEffectsPossible,
                requiresOperatorApproval: externalEffectsPossible,
                reason: externalEffectsPossible
                  ? `Raw execution may perform ${externalEffectReasons.join('; ')}.`
                  : 'The graph is statically local and deterministic.',
              },
            },
          });
    }
    if (target === 'unattended') {
      checks.push(hardened
        ? { id: `hardened:${workflow.id}`, layer: 'test', status: 'pass', workflowId: workflow.id, summary: `Workflow "${workflow.title}" is hardened at the current graph.` }
        : {
            id: `hardened:${workflow.id}`, layer: 'test', status: 'block', workflowId: workflow.id,
            blocksExecution: false,
            summary: `Workflow "${workflow.title}" is not hardened at its current graph.`,
            clearWith: { tool: 'agentis.workflow.harden', args: { workflowId: workflow.id }, why: 'Freeze current proof before unattended activation.' },
          });
    }

    checks.push(...channelChecks(db, workspaceId, workflow.id, workflow.title, graph));
  }

  checks.push(...conversationLivenessChecks(db, workspaceId, appId, snapshot));
  checks.push(...channelIdentityChecks(db, workspaceId, appId, snapshot));

  if (snapshot.surfaces.length === 0) {
    checks.push({
      id: 'surface:none', layer: 'surface', status: 'warn',
      summary: 'This App has no operator surface. That is valid for a declared headless automation, but interactive Apps need an operable interface.',
      clearWith: { tool: 'agentis.ui.render', args: { appId, surface: 'home' }, why: 'Author an operator interface, or intentionally keep the App headless.' },
    });
  }
  for (const surface of snapshot.surfaces) {
    const parsed = viewNodeSchema.safeParse(surface.view);
    if (!parsed.success) {
      checks.push({
        id: `surface-schema:${surface.id}`, layer: 'surface', status: 'block',
        summary: `Surface "${surface.name}" is not a valid ViewNode tree.`,
        evidence: { issues: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join('/')}: ${issue.message}`) },
        clearWith: { tool: 'agentis.ui.lint', args: { appId, surface: surface.name }, why: 'Repair the surface schema before delivery.' },
      });
      continue;
    }
    const repaired = repairSurface(parsed.data, { collections: snapshot.collections.map((collection) => collection.name), actions: surface.actions });
    checks.push(repaired.fixes.length === 0
      ? { id: `surface-operable:${surface.id}`, layer: 'surface', status: 'pass', summary: `Surface "${surface.name}" passes the operability gate.` }
      : {
          id: `surface-operable:${surface.id}`, layer: 'surface', status: 'block',
          summary: `Surface "${surface.name}" requires ${repaired.fixes.length} operability repair(s).`, evidence: { fixes: repaired.fixes },
          clearWith: { tool: 'agentis.ui.lint', args: { appId, surface: surface.name }, why: 'Apply the lint findings instead of shipping a merely rendered surface.' },
        });
  }

  const counts: Record<AppCompileStatus, number> = { pass: 0, block: 0, warn: 0, not_applicable: 0 };
  for (const check of checks) counts[check.status] += 1;
  const next = dedupeNext(checks.filter((check) => check.status === 'block' && check.clearWith).map((check) => check.clearWith!));
  const repairPlan = {
    zeroCost: next.filter((step) => step.tool !== 'agentis.workflow.run'),
    liveProof: next.filter((step) => step.tool === 'agentis.workflow.run'),
  };
  const structuralLayers = new Set<AppCompileLayer>(['topology', 'activation', 'outcome', 'surface']);
  const structuralReady = !checks.some((check) => check.status === 'block' && structuralLayers.has(check.layer));
  const executionBlockerCount = checks.filter((check) => check.status === 'block' && check.blocksExecution !== false).length;
  const evidencePendingCount = checks.filter((check) => check.status === 'block' && check.blocksExecution === false).length;
  const readyForExecution = structuralReady && executionBlockerCount === 0;
  const executableReady = readyForExecution;
  const ready = structuralReady && counts.block === 0;
  return {
    appId, target, generatedAt: now.toISOString(), structuralReady, executableReady, ready, readyForExecution, executionBlockerCount, evidencePendingCount, counts, checks, workflowProofs, next, repairPlan,
    summary: ready
      ? `COMPILED: App is ready for ${target} execution (${counts.pass} checks passed${counts.warn ? `, ${counts.warn} warning(s)` : ''}).`
      : readyForExecution
        ? `EXECUTABLE: ${evidencePendingCount} ${target} evidence/hardening gate(s) remain, but they do not block the manual runs that create proof.`
        : structuralReady
          ? `STRUCTURALLY COMPILED, NOT EXECUTABLE: ${executionBlockerCount} runtime/configuration blocker(s) remain. Apply every compatible repairPlan.zeroCost step in one batch, then compile once.`
        : `NOT STRUCTURALLY COMPILED: ${counts.block} blocker(s) remain before ${target} execution. Apply every compatible repairPlan.zeroCost step in one batch, then compile once; do not repair one blocker per model round.`,
  };
}

function conversationLivenessChecks(
  db: AgentisSqliteDb,
  workspaceId: string,
  appId: string,
  snapshot: ReturnType<typeof collectAppDoctorSnapshot>,
): AppCompileCheck[] {
  const scriptCollection = snapshot.collections.find((collection) => collection.name === 'conversation_script');
  const scripts = (scriptCollection?.records ?? [])
    .map((item) => conversationScriptSchema.safeParse(item.data.script))
    .filter((parsed): parsed is Extract<typeof parsed, { success: true }> => parsed.success)
    .map((parsed) => parsed.data);
  if (scripts.length === 0) return [];

  const collectionRows = db.select({ id: schema.appCollections.id, name: schema.appCollections.name })
    .from(schema.appCollections)
    .where(and(eq(schema.appCollections.workspaceId, workspaceId), eq(schema.appCollections.appId, appId)))
    .all();
  const collectionNameById = new Map(collectionRows.map((collection) => [collection.id, collection.name]));
  // Bounded inspection keeps compilation fast even for large business tables.
  const records = db.select({ id: schema.appRecords.id, collectionId: schema.appRecords.collectionId, data: schema.appRecords.dataJson })
    .from(schema.appRecords)
    .where(and(eq(schema.appRecords.workspaceId, workspaceId), eq(schema.appRecords.appId, appId)))
    .orderBy(desc(schema.appRecords.updatedAt))
    .limit(1000)
    .all();
  const workflowById = new Map(snapshot.workflows.map((workflow) => [workflow.id, workflow]));
  const checks: AppCompileCheck[] = [];

  for (const script of scripts) {
    const stageIds = new Set(script.stages.map((stage) => stage.id));
    const reachable = new Set<string>();
    const frontier = [script.initialStage];
    while (frontier.length > 0) {
      const stageId = frontier.shift()!;
      if (reachable.has(stageId)) continue;
      reachable.add(stageId);
      const stage = script.stages.find((candidate) => candidate.id === stageId);
      if (!stage) continue;
      const next = [
        ...(stage.onReply?.kind === 'goto' ? [stage.onReply.stage] : []),
        ...(stage.onReply?.kind === 'classify' ? Object.values(stage.onReply.branches) : []),
        ...(stage.onComplete ? [stage.onComplete.stage] : []),
      ];
      for (const id of next) if (!reachable.has(id)) frontier.push(id);
    }
    const unreachable = [...stageIds].filter((id) => !reachable.has(id));
    const terminalReachable = script.stages.some((stage) => stage.terminal === true && reachable.has(stage.id));
    checks.push(unreachable.length === 0 && terminalReachable
      ? { id: `conversation-reachability:${script.contactCollection}`, layer: 'activation', status: 'pass', summary: `Conversation script for "${script.contactCollection}" has a closed path from enrollment to a terminal stage.` }
      : {
          id: `conversation-reachability:${script.contactCollection}`, layer: 'activation', status: 'block',
          summary: `Conversation script for "${script.contactCollection}" is not closed-loop reachable.`,
          evidence: { initialStage: script.initialStage, unreachableStages: unreachable, terminalReachable },
          clearWith: { tool: 'agentis.conversation.define', args: { appId }, why: 'Connect every intended state and provide at least one reachable terminal outcome.' },
        });

    const collection = snapshot.collections.find((candidate) => candidate.name === script.contactCollection);
    const fields = new Set(collection?.schema.fields.map((field) => field.key) ?? []);
    const identitySchemaReady = fields.has('address') && fields.has('stage') && (collection?.schema.strict !== true || fields.has('connectionId'));
    checks.push(identitySchemaReady
      ? { id: `conversation-identity-schema:${script.contactCollection}`, layer: 'activation', status: 'pass', summary: `Runtime contact collection "${script.contactCollection}" can persist address, connection, and state identity.` }
      : {
          id: `conversation-identity-schema:${script.contactCollection}`, layer: 'activation', status: 'block',
          summary: `Runtime contact collection "${script.contactCollection}" cannot persist the identity needed to resume inbound events.`,
          evidence: { fields: [...fields], strict: collection?.schema.strict ?? false, requiredRuntimeFields: ['address', 'stage', 'connectionId'] },
          clearWith: { tool: 'agentis.conversation.define', args: { appId }, why: 'Recreate/repair the script contact collection with the runtime identity contract.' },
        });

    const contactCollectionId = collectionRows.find((candidate) => candidate.name === script.contactCollection)?.id;
    const contactRecords = records.filter((recordRow) => recordRow.collectionId === contactCollectionId);
    const enrolled = contactRecords.filter((recordRow) => {
      const data = record(recordRow.data);
      return Boolean(
        data?.status === 'active'
        && nonempty(data?.address)
        && nonempty(data?.connectionId)
        && nonempty(data?.stage)
        && stageIds.has(String(data?.stage)),
      );
    });
    const blockedContacts = contactRecords.filter((recordRow) => record(recordRow.data)?.status === 'blocked');
    if (blockedContacts.length > 0) {
      checks.push({
        id: `conversation-blocked-contacts:${script.contactCollection}`,
        layer: 'runtime',
        status: 'block',
        summary: `${blockedContacts.length} contact(s) are blocked on unproven stage entry side effects and cannot receive the next event safely.`,
        evidence: { contacts: blockedContacts.slice(0, 20).map((item) => ({ id: item.id, stage: record(item.data)?.stage, blocker: record(item.data)?.blocker })) },
        clearWith: { tool: 'agentis.conversation.enroll', args: { appId }, why: 'Inspect the durable blocker and retry through the same idempotency key only after provider state is known.' },
      });
    }
    const malformed = contactRecords.filter((recordRow) => {
      const data = record(recordRow.data);
      return nonempty(data?.stage) && (!nonempty(data?.address) || !nonempty(data?.connectionId));
    });
    if (malformed.length > 0) {
      checks.push({
        id: `conversation-malformed-enrollment:${script.contactCollection}`, layer: 'activation', status: 'block',
        summary: `${malformed.length} contact state record(s) have a stage but no complete address/connection identity, so inbound events cannot resume them.`,
        evidence: { recordIds: malformed.slice(0, 20).map((item) => item.id) },
        clearWith: { tool: 'agentis.conversation.enroll', args: { appId }, why: 'Enroll through the conversation runtime; writing a stage label alone is not enrollment.' },
      });
    }

    // Detect a common but domain-neutral split-brain: a producer writes one of
    // the script's states into a business table, while the dispatcher only reads
    // the canonical runtime contact collection by address.
    const externalStageRecords = records.filter((recordRow) => {
      if (recordRow.collectionId === contactCollectionId || collectionNameById.get(recordRow.collectionId) === 'conversation_script') return false;
      const data = record(recordRow.data);
      return nonempty(data?.stage) && stageIds.has(String(data?.stage));
    });
    const enrolledAddresses = new Set(enrolled.map((item) => String(record(item.data)?.address)));
    const stranded = externalStageRecords.filter((item) => {
      const data = record(item.data);
      const address = String(data?.address ?? data?.channelAddress ?? '');
      return !address || !enrolledAddresses.has(address);
    });
    if (stranded.length > 0) {
      checks.push({
        id: `conversation-stranded-producer-state:${script.contactCollection}`, layer: 'activation', status: 'block',
        summary: `${stranded.length} business record(s) use conversation stage ids but are not enrolled in the runtime contact state machine.`,
        evidence: { records: stranded.slice(0, 20).map((item) => ({ id: item.id, collection: collectionNameById.get(item.collectionId), stage: record(item.data)?.stage })) },
        clearWith: { tool: 'agentis.conversation.enroll', args: { appId }, why: 'Bridge producer output into real runtime enrollment with address and connectionId; a copied awaiting_* label cannot receive an event.' },
      });
    }
    const dataWriters = snapshot.workflows.flatMap((workflow) => workflow.graph.nodes.flatMap((node) => {
      if (node.config.kind !== 'data_mutate') return [];
      const config = node.config as unknown as Record<string, unknown>;
      const collectionName = typeof config.collection === 'string' ? config.collection : '';
      const recordShape = JSON.stringify(config.record ?? {});
      return [{ workflowId: workflow.id, nodeId: node.id, collectionName, recordShape }];
    }));
    const stageProducingWriters = dataWriters.filter((writer) =>
      writer.collectionName !== script.contactCollection
      && /["']?stage["']?\s*:/i.test(writer.recordShape)
      && [...stageIds].some((stageId) => writer.recordShape.includes(stageId)),
    );
    const enrollmentWriters = dataWriters.filter((writer) =>
      writer.collectionName === script.contactCollection
      && /address/i.test(writer.recordShape)
      && /connectionId/i.test(writer.recordShape)
      && /stage/i.test(writer.recordShape),
    );
    if (stageProducingWriters.length > 0 && enrollmentWriters.length === 0) {
      checks.push({
        id: `conversation-producer-not-enrolling:${script.contactCollection}`, layer: 'activation', status: 'block',
        summary: `Workflow nodes produce conversation stage state in business data but no deterministic node enrolls the same contact identity in "${script.contactCollection}".`,
        evidence: { stageProducers: stageProducingWriters.map(({ workflowId, nodeId, collectionName }) => ({ workflowId, nodeId, collectionName })) },
        clearWith: { tool: 'agentis.build_workflow', args: { workflowId: stageProducingWriters[0]!.workflowId, description: `after producing the contact stage, upsert ${script.contactCollection} with address, connectionId, stage, and facts so inbound events can resume it` }, why: 'Compile producer output into durable runtime enrollment for every future contact; manually enrolling one current row is not an automation.' },
      });
    } else if (enrollmentWriters.length > 0) {
      checks.push({ id: `conversation-enrollment-producer:${script.contactCollection}`, layer: 'activation', status: 'pass', summary: `A deterministic workflow writer persists resumable enrollment identity into "${script.contactCollection}".` });
    }
    if (enrolled.length === 0) {
      checks.push({
        id: `conversation-no-enrollment:${script.contactCollection}`, layer: 'runtime', status: 'block',
        summary: `The conversation state machine has no executable enrolled contact. Structural readiness is not executable readiness.`,
        evidence: { contactCollection: script.contactCollection, producerStageRecords: externalStageRecords.length },
        clearWith: { tool: 'agentis.conversation.enroll', args: { appId }, why: 'Enroll a real or test contact using its channel address and connectionId before claiming end-to-end readiness.' },
      });
    } else {
      checks.push({ id: `conversation-enrollment:${script.contactCollection}`, layer: 'runtime', status: 'pass', summary: `${enrolled.length} contact(s) have resumable runtime enrollment identity.` });
    }

    const scriptTargets = new Set(script.stages.flatMap((stage) => stage.entry?.kind === 'run_workflow' ? [stage.entry.workflowId] : []));
    for (const targetId of scriptTargets) {
      const workflow = workflowById.get(targetId);
      if (!workflow) continue;
      const binding = appWorkflowBindingSchema.safeParse(record(workflow.settings)?.appBinding ?? {});
      const dependencies = binding.success ? binding.data.dependsOn ?? [] : [];
      if (dependencies.length === 0) continue;
      checks.push({
        id: `conversation-mixed-activation:${targetId}`, layer: 'activation', status: 'block', workflowId: targetId,
        summary: `Workflow "${workflow.title}" is activated by a conversation event but also has success dependencies, creating two incompatible wake paths.`,
        evidence: { dependsOn: dependencies, activation: 'conversation.run_workflow' },
        clearWith: { tool: 'agentis.workflow.chain', args: { appId }, why: 'Remove completion dependencies from human/event-driven work; the persisted state/event owns its activation.' },
      });
    }
  }
  return checks;
}

function doctorCheck(finding: AppDoctorFinding): AppCompileCheck {
  const blocking = finding.severity === 'critical' || finding.severity === 'error';
  return {
    id: `doctor:${finding.id}`,
    layer: doctorLayer(finding.layer),
    status: blocking ? 'block' : 'warn',
    summary: finding.summary,
    evidence: { code: finding.code, ...finding.evidence },
    clearWith: {
      tool: remediationTool(finding.remediation.operation),
      args: finding.remediation.args ?? {},
      why: finding.remediation.description,
    },
  };
}

function doctorLayer(layer: AppDoctorFinding['layer']): AppCompileLayer {
  if (layer === 'binding') return 'topology';
  if (layer === 'event' || layer === 'state') return 'activation';
  if (layer === 'connection') return 'channel';
  return layer;
}

function remediationTool(operation: string): string {
  const map: Record<string, string> = {
    'workflow.graph.patch': 'agentis.build_workflow',
    'workflow.binding.patch': 'agentis.workflow.chain',
    'workflow.spec.define': 'agentis.workflow.scope',
    'workflow.spec.reconcile': 'agentis.workflow.scope',
    'workflow.trigger.arm': 'agentis.workflow.harden',
    'workflow.chain': 'agentis.workflow.chain',
    'connection.bind_app': 'agentis.connection.bind_app',
    'conversation.define': 'agentis.conversation.define',
    'data.define_collection': 'agentis.data.define_collection',
    'ui.action_schema': 'agentis.ui.action_schema',
    'ui.action_schema.patch': 'agentis.ui.action_schema',
  };
  return map[operation] ?? `agentis.${operation}`;
}

function channelChecks(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowId: string,
  title: string,
  graph: WorkflowGraph,
): AppCompileCheck[] {
  const nodes = graph.nodes.filter((node) => node.config.kind === 'channel');
  if (nodes.length === 0) return [];
  const connections = db.select({ id: schema.channelConnections.id, kind: schema.channelConnections.kind, status: schema.channelConnections.status, settings: schema.channelConnections.settings })
    .from(schema.channelConnections).where(eq(schema.channelConnections.workspaceId, workspaceId)).all();
  return nodes.map((node) => {
    const config = node.config as unknown as Record<string, unknown>;
    const connectionId = typeof config.connectionId === 'string' ? config.connectionId.trim() : '';
    const kind = typeof config.channelKind === 'string' ? config.channelKind.trim() : '';
    const outboundReady = (connection: typeof connections[number]) => {
      if (connection.status !== 'active' && connection.status !== 'degraded') return false;
      const health = record(connection.settings)?.health;
      const checks = Array.isArray(record(health)?.checks) ? record(health)?.checks as unknown[] : [];
      const outbound = checks.map(record).find((check) => check?.name === 'outbound');
      return outbound?.ok !== false;
    };
    const candidates = connections.filter((connection) => outboundReady(connection) && (!kind || connection.kind === kind));
    const explicit = connectionId ? connections.find((connection) => connection.id === connectionId && outboundReady(connection)) : undefined;
    const defaults = candidates.filter((connection) => record(connection.settings)?.isDefault === true);
    const resolvable = Boolean(explicit) || (!connectionId && (defaults.length === 1 || candidates.length === 1));
    return resolvable
      ? { id: `channel:${workflowId}:${node.id}`, layer: 'channel', status: 'pass', workflowId, summary: `Channel step "${node.title || node.id}" in "${title}" resolves to an active connection.` }
      : {
          id: `channel:${workflowId}:${node.id}`, layer: 'channel', status: 'block', workflowId,
          summary: `Channel step "${node.title || node.id}" in "${title}" cannot resolve one active connection.`,
          evidence: {
            connectionId: connectionId || null,
            kind: kind || null,
            outboundReadyCandidates: candidates.map((connection) => connection.id),
            activeDefaults: defaults.map((connection) => connection.id),
            referencedConnectionHealth: connectionId
              ? record(connections.find((connection) => connection.id === connectionId)?.settings)?.health
              : undefined,
          },
          clearWith: { tool: 'agentis.channel.list', args: {}, why: 'Connect one outbound-capable channel and pin connectionId or configure one default for this kind.' },
        };
  });
}

function channelIdentityChecks(
  db: AgentisSqliteDb,
  workspaceId: string,
  appId: string,
  snapshot: ReturnType<typeof collectAppDoctorSnapshot>,
): AppCompileCheck[] {
  const referencedIds = new Set(snapshot.workflows.flatMap((workflow) => workflow.graph.nodes.flatMap((node) => {
    if (node.config.kind !== 'channel') return [];
    const id = String((node.config as unknown as Record<string, unknown>).connectionId ?? '').trim();
    return id ? [id] : [];
  })));
  const connections = db.select({
    id: schema.channelConnections.id,
    appId: schema.channelConnections.appId,
    name: schema.channelConnections.name,
    kind: schema.channelConnections.kind,
    status: schema.channelConnections.status,
    settings: schema.channelConnections.settings,
  }).from(schema.channelConnections)
    .where(and(eq(schema.channelConnections.workspaceId, workspaceId), eq(schema.channelConnections.kind, 'whatsapp')))
    .all();
  const byIdentity = new Map<string, typeof connections>();
  for (const connection of connections) {
    const selfId = String(record(connection.settings)?.selfId ?? '').trim().toLowerCase();
    const identity = selfId.split('@')[0]?.split(':')[0]?.replace(/\D/gu, '') ?? '';
    if (!identity) continue;
    const bucket = byIdentity.get(identity) ?? [];
    bucket.push(connection);
    byIdentity.set(identity, bucket);
  }
  const checks: AppCompileCheck[] = [];
  for (const [identity, group] of byIdentity) {
    if (group.length < 2 || !group.some((connection) => connection.appId === appId || referencedIds.has(connection.id))) continue;
    const active = group.filter((connection) => connection.status === 'active');
    const status: AppCompileStatus = active.length > 1 ? 'block' : 'warn';
    checks.push({
      id: `channel-duplicate-identity:${identity}`,
      layer: 'channel',
      status,
      summary: `${group.length} WhatsApp connections represent the same sender identity; ${active.length} are active. Duplicate logical connections make defaults, health, and inbound ownership ambiguous.`,
      evidence: { identity, connections: group.map(({ id, name, status: connectionStatus, appId: boundAppId }) => ({ id, name, status: connectionStatus, appId: boundAppId })) },
      ...(status === 'block' ? {
        clearWith: { tool: 'agentis.channel.list', args: {}, why: 'Keep one active logical connection per sender identity, then bind Apps/grants to that canonical connection.' },
      } : {}),
    });
  }
  return checks;
}

function dedupeNext(steps: AppCompileAction[]) {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = `${step.tool}:${JSON.stringify(step.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonempty(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}
