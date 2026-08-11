/**
 * App-planning tool (GAP A1/B4) — the "plan-first" scaffold.
 *
 * The build path reflexively authors ONE workflow. But a real App is a
 * composition: several workflows (with an order + dependencies), a resident cast,
 * senses, a datastore, an outbound policy, and — for outreach — a conversation
 * script. `agentis.app.plan` makes the agent enumerate those parts BEFORE building
 * (progressive comprehension), ensures the App shell, applies the policy, records
 * the blueprint, and returns an ORDERED checklist of the exact next calls. It
 * anchors decomposition instead of leaving it to improvisation.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolContext } from '@agentis/core';
import { buildAppStores } from '@agentis/app';
import { z } from 'zod';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

const planWorkflowSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  /** Sibling workflow keys that must run first (App-level chaining). */
  dependsOn: z.array(z.string()).default([]),
  /** How it wakes: manual | schedule | webhook | listener | conversation. */
  trigger: z.string().optional(),
  /** Runtime activation is distinct from build order/decomposition. */
  activation: z.enum(['after_success', 'event', 'operator']).optional(),
  ownerRoleKey: z.string().min(1).optional(),
  swarmKey: z.string().min(1).optional(),
  inputs: z.array(z.object({
    key: z.string().min(1),
    type: z.enum(['string', 'number', 'boolean', 'array', 'object', 'any']),
    required: z.boolean().optional(),
    description: z.string().optional(),
  })).default([]),
  outputs: z.array(z.object({
    key: z.string().min(1),
    type: z.enum(['string', 'number', 'boolean', 'array', 'object', 'any']),
    required: z.boolean().optional(),
    description: z.string().optional(),
  })).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  /** Persisted definition of done installed after authoring. */
  success: z.object({
    objective: z.string().min(1),
    acceptance: z.array(z.record(z.unknown())).min(1),
    sufficiency: z.array(z.record(z.unknown())).optional(),
    constraints: z.record(z.unknown()).optional(),
  }).optional(),
});

const appPlanSchema = z.object({
  appId: z.string().optional(),
  name: z.string().optional(),
  intent: z.string().min(1),
  workflows: z.array(planWorkflowSchema).default([]),
  /** True when the App drives a per-contact outreach conversation (→ define a script). */
  conversation: z.boolean().default(false),
  collections: z.array(z.object({ name: z.string().min(1), purpose: z.string().optional() })).default([]),
  cast: z.array(z.object({
    key: z.string().min(1),
    role: z.string().min(1),
    name: z.string().optional(),
    durable: z.literal(true).default(true),
    runtime: z.object({
      runtime: z.string().optional(),
      model: z.string().optional(),
      capabilities: z.array(z.string()).default([]),
    }).optional(),
    skillIds: z.array(z.string()).default([]),
    brainIds: z.array(z.string()).default([]),
  })).default([]),
  swarms: z.array(z.object({
    key: z.string().min(1),
    purpose: z.string().min(1),
    workerRole: z.string().min(1),
    maxWorkers: z.number().int().min(1).max(32),
    runtime: z.object({
      runtime: z.string().optional(),
      model: z.string().optional(),
      capabilities: z.array(z.string()).default([]),
    }).optional(),
    skillIds: z.array(z.string()).default([]),
    brainIds: z.array(z.string()).default([]),
    persist: z.literal('evidence_only').default('evidence_only'),
  })).default([]),
  interfaces: z.array(z.object({
    key: z.string().min(1),
    title: z.string().min(1),
    purpose: z.string().min(1),
  })).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  policy: z
    .object({
      maxPerHour: z.number().int().positive().optional(),
      quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).optional(),
    })
    .optional(),
}).superRefine((plan, ctx) => {
  const keys = new Set<string>();
  for (const [index, workflow] of plan.workflows.entries()) {
    if (keys.has(workflow.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workflows', index, 'key'], message: `duplicate workflow key: ${workflow.key}` });
    }
    keys.add(workflow.key);
  }
  const graph = new Map(plan.workflows.map((workflow) => [workflow.key, workflow.dependsOn]));
  for (const [index, workflow] of plan.workflows.entries()) {
    for (const dependency of workflow.dependsOn) {
      if (dependency === workflow.key) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workflows', index, 'dependsOn'], message: `${workflow.key} cannot depend on itself` });
      } else if (!graph.has(dependency)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workflows', index, 'dependsOn'], message: `unknown workflow dependency: ${dependency}` });
      }
    }
  }
  const cycle = firstKeyCycle(graph);
  if (cycle) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workflows'], message: `workflow dependency cycle: ${cycle.join(' -> ')}` });
});

interface ChecklistStep {
  step: number;
  id: string;
  tool: string;
  args: Record<string, unknown>;
  why: string;
  dependsOnSteps?: string[];
  capture?: Record<string, string>;
}

export function registerAppPlanTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.app.plan',
        family: 'build',
        mcpExposed: true,
        description:
          '[PLAN-FIRST] Before building, DECOMPOSE a non-trivial request into an App of parts and get an ordered '
          + 'build checklist. Use this whenever the intent is multi-step, conversational, recurring, or names more than '
          + 'one job (e.g. "find leads AND message them AND build their store") — do NOT collapse it into one workflow. '
          + 'You enumerate: the workflows (each with a purpose + build dependencies + runtime activation), whether it needs a per-contact conversation '
          + 'script, the datastore collections, the resident cast, bounded swarms, and the outbound policy (rate/quiet-hours). It captures '
          + 'a grounded workspace snapshot, validates the blueprint before creating the App, and returns the exact next calls IN ORDER '
          + '(build each workflow → free SWIFT proof → wire the senses/surface → compile the whole App → one real debug run). Then execute the checklist.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'Existing App to plan into (optional — a shell App is created from `name` otherwise).' },
            name: { type: 'string', description: 'App name when creating a new one.' },
            intent: { type: 'string', description: 'What this App is for, in one or two sentences.' },
            workflows: {
              type: 'array',
              description: 'Distinct automation subroutines. Each: { key, title, purpose, dependsOn?: [keys], trigger?, activation?: "after_success"|"event"|"operator", success? }. `dependsOn` orders construction; activation decides runtime. Human replies/permissions, channel messages, webhooks, listeners, and schedules are `event`, never `after_success`.',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Stable semantic key; never a numbered/versioned feature name.' },
                  title: { type: 'string' },
                  purpose: { type: 'string' },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  trigger: { type: 'string' },
                  activation: { type: 'string', enum: ['after_success', 'event', 'operator'] },
                  acceptanceCriteria: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' },
                    description: 'At least one evidence-checkable condition proving this workflow accomplished its purpose.',
                  },
                },
                required: ['key', 'title', 'purpose', 'acceptanceCriteria'],
              },
            },
            conversation: { type: 'boolean', description: 'True when the App runs a per-contact outreach script (→ agentis.conversation.define).' },
            collections: { type: 'array', description: 'Datastore collections: [{ name, purpose }].', items: { type: 'object' } },
            cast: { type: 'array', description: 'Enduring roles only: [{ key, role, name?, durable:true, runtime?, skillIds?, brainIds? }]. Temporary workers belong in swarms.', items: { type: 'object' } },
            swarms: { type: 'array', description: 'Bounded temporary workers: [{ key, purpose, workerRole, maxWorkers, runtime?, skillIds?, brainIds?, persist:"evidence_only" }].', items: { type: 'object' } },
            interfaces: { type: 'array', description: 'Operator/App surfaces: [{ key, title, purpose }].', items: { type: 'object' } },
            acceptanceCriteria: { type: 'array', minItems: 1, description: 'App-level evidence-checkable completion criteria. At least one is required by the blueprint gate.', items: { type: 'string' } },
            policy: { type: 'object', description: 'Outbound safety envelope: { maxPerHour?, quietHours?: { start, end } }.' },
          },
          required: ['intent', 'acceptanceCriteria'],
          anyOf: [{ required: ['appId'] }, { required: ['name'] }],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (rawArgs, ctx) => {
        const args = appPlanSchema.parse(rawArgs);
        if (!deps.buildSessions) throw new AgentisError('VALIDATION_FAILED', 'The authoritative build-session service is unavailable.');
        const stores = buildAppStores({ db: deps.db, bus: deps.bus });
        const existingAppId = (args.appId && args.appId.trim()) || ctx.appId || null;
        const appName = args.name?.trim()
          || (existingAppId ? stores.store.get(ctx.workspaceId, existingAppId).name : '');
        if (!appName) throw new AgentisError('VALIDATION_FAILED', 'app.plan needs a semantic name when creating an App.');
        const created = deps.buildSessions.create({
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          ownerAgentId: ctx.agentId ?? null,
          conversationId: ctx.conversationId ?? null,
          appId: existingAppId,
          name: appName,
          intent: args.intent,
          topology: {
            roles: args.cast,
            swarms: args.swarms,
            workflows: args.workflows.map((workflow) => ({
              key: workflow.key,
              title: workflow.title,
              purpose: workflow.purpose,
              dependsOn: workflow.dependsOn,
              activation: workflowActivation(workflow),
              ...(workflow.trigger ? { trigger: workflow.trigger } : {}),
              ...(workflow.ownerRoleKey ? { ownerRoleKey: workflow.ownerRoleKey } : {}),
              ...(workflow.swarmKey ? { swarmKey: workflow.swarmKey } : {}),
              inputs: workflow.inputs,
              outputs: workflow.outputs,
              acceptanceCriteria: workflow.acceptanceCriteria.length > 0
                ? workflow.acceptanceCriteria
                : workflow.success
                  ? [workflow.success.objective]
                  : [],
            })),
            collections: args.collections.map((collection) => ({ key: collection.name, purpose: collection.purpose })),
            interfaces: args.interfaces,
          },
          acceptanceCriteria: args.acceptanceCriteria,
          capabilityCatalogHash: registry.catalog().hash,
        });
        if (!created.blueprint.validation.valid) {
          throw new AgentisError('VALIDATION_FAILED', 'The App blueprint is incomplete; no App was materialized.', {
            remediation: 'Repair every reported topology/acceptance issue, then call agentis.app.plan again.',
            details: {
              buildSessionId: created.session.id,
              blueprintId: created.blueprint.id,
              issues: created.blueprint.validation.issues,
            },
          });
        }
        const appId = ensureApp(stores, args, ctx);
        const buildSession = deps.buildSessions.bindApp(ctx.workspaceId, created.session.id, appId);

        // Apply the outbound safety envelope now (the agent rarely sets it later).
        if (args.policy) {
          try {
            stores.store.update(ctx.workspaceId, appId, { policy: { outbound: args.policy } });
          } catch (err) {
            deps.logger.warn('app.plan.policy_failed', { appId, err: (err as Error).message });
          }
        }

        const checklist = buildChecklist(appId, args);
        return {
          appId,
          buildSessionId: buildSession.id,
          blueprintId: created.blueprint.id,
          blueprintRevision: created.blueprint.revision,
          blueprintStatus: created.blueprint.status,
          workspaceSnapshotAt: buildSession.snapshot.capturedAt,
          intent: args.intent,
          parts: {
            workflows: args.workflows.length,
            conversation: args.conversation,
            collections: args.collections.length,
            cast: args.cast.length,
            swarms: args.swarms.length,
            interfaces: args.interfaces.length,
            policy: Boolean(args.policy),
          },
          checklist,
          message:
            `Validated App blueprint recorded (${args.workflows.length} workflow(s)${args.conversation ? ' + a conversation script' : ''}). `
            + 'Now EXECUTE the checklist in order: build each workflow and complete its FREE proof (scope → dry_run → suite), '
            + 'then wire the senses (script/triggers) and compile the whole App. Spend on one real debug run only after app.compile is ready. Do not collapse these into one workflow.',
          compass: { stage: 'authored' as const, summary: 'App decomposed into parts. Execute the checklist top-to-bottom.', next: checklist.slice(0, 1).map(({ tool, args: a, why }) => ({ tool, args: a, why })) },
        };
      },
    },
  ]);
}

function ensureApp(stores: ReturnType<typeof buildAppStores>, args: z.infer<typeof appPlanSchema>, ctx: AgentisToolContext): string {
  const appId = (args.appId && args.appId.trim()) || ctx.appId;
  if (appId) {
    stores.store.get(ctx.workspaceId, appId);
    return appId;
  }
  if (!args.name?.trim()) throw new AgentisError('VALIDATION_FAILED', 'app.plan needs an appId or a name to create the App');
  const app = stores.store.create(ctx.workspaceId, ctx.userId, { name: args.name.trim(), description: args.intent.slice(0, 400) });
  return app.id;
}

/** Ordered next calls: dependency-respecting workflow builds, then the script + collections. */
export function buildChecklist(appId: string, args: z.infer<typeof appPlanSchema>): ChecklistStep[] {
  const steps: ChecklistStep[] = [];
  let n = 1;
  for (const wf of orderByDependsOn(args.workflows)) {
    const buildId = `build_${wf.key}`;
    steps.push({
      step: n++,
      id: buildId,
      tool: 'agentis.build_workflow',
      args: {
        appId,
        title: wf.title,
        description: `${wf.title}: ${wf.purpose}${wf.trigger ? ` Trigger: ${wf.trigger}.` : ''}`,
        newWorkflow: true,
      },
      capture: { workflowId: `workflows.${wf.key}.workflowId`, appId: 'appId' },
      why: `Author the "${wf.key}" part${wf.dependsOn.length ? ` (runs after: ${wf.dependsOn.join(', ')})` : ''}, then SWIFT-verify it (dry_run → debug → verdict) before the next.`,
    });
    if (wf.success) {
      steps.push({
        step: n++,
        id: `scope_${wf.key}`,
        tool: 'agentis.workflow.scope',
        args: { workflowId: `\${workflows.${wf.key}.workflowId}`, spec: wf.success },
        why: `Install the definition of done for "${wf.key}" so completion alone cannot advance the App.`,
        dependsOnSteps: [buildId],
      });
    }
  }
  if (args.workflows.length > 0) {
    steps.push({
      step: n++,
      id: 'compile_workflow_rules',
      tool: 'agentis.workflow.chain',
      args: {
        appId,
        workflows: args.workflows.map((wf, order) => {
          const activation = workflowActivation(wf);
          return {
            workflowId: `\${workflows.${wf.key}.workflowId}`,
            order,
            purpose: wf.purpose,
            // Build prerequisites are not automatically runtime progression.
            // Event-driven work is woken by its real persisted sense/script.
            dependsOn: activation === 'after_success'
              ? wf.dependsOn.map((key) => `\${workflows.${key}.workflowId}`)
              : [],
            operatorEntrypoint: activation === 'operator'
              || (activation === 'after_success' && wf.dependsOn.length === 0),
            chainOn: 'success',
            enabled: true,
          };
        }),
      },
      why: 'Compile runtime activation honestly: success-gated dependencies for direct progression, operator entrypoints for manual roots, and event-only roots that wait for their persisted channel/listener/script instead of Run Pipeline.',
      dependsOnSteps: args.workflows.map((wf) => `build_${wf.key}`),
    });
  }
  for (const col of args.collections) {
    steps.push({ step: n++, id: `collection_${col.name}`, tool: 'agentis.data.define_collection', args: { appId, name: col.name }, why: col.purpose ?? `Datastore collection "${col.name}".` });
  }
  if (args.conversation) {
    steps.push({
      step: n++,
      id: 'define_conversation',
      tool: 'agentis.conversation.define',
      args: { appId },
      why: 'Install the per-contact outreach script (deterministic greeting → agent pitch → classify → run_workflow → terminal stop) — the platform primitive for await-reply, token-free where scripted. Do NOT hand-roll this with an agent loop.',
    });
  }
  const prerequisites = steps.map((step) => step.id);
  steps.push({
    step: n++,
    id: 'verify_app',
    tool: 'agentis.app.verify',
    args: { appId, target: 'debug' },
    why: 'Verify and compile the whole executable App — topology, activation, contracts, current-graph tests, runtime/channels, and surfaces — before spending on one real debug run. This evidence settles the durable build session.',
    dependsOnSteps: prerequisites,
  });
  return steps;
}

function workflowActivation(workflow: z.infer<typeof planWorkflowSchema>): 'after_success' | 'event' | 'operator' {
  if (workflow.activation) return workflow.activation;
  const trigger = workflow.trigger?.toLowerCase() ?? '';
  if (/conversation|reply|permission|inbound|channel|webhook|listener|schedule|cron|event/.test(trigger)) return 'event';
  return workflow.dependsOn.length > 0 ? 'after_success' : 'operator';
}

/** Stable order that puts a workflow after everything it dependsOn (best-effort). */
export function orderByDependsOn(workflows: z.infer<typeof planWorkflowSchema>[]): z.infer<typeof planWorkflowSchema>[] {
  const done = new Set<string>();
  const out: z.infer<typeof planWorkflowSchema>[] = [];
  const remaining = [...workflows];
  let guard = remaining.length * remaining.length + 1;
  while (remaining.length && guard-- > 0) {
    const i = remaining.findIndex((w) => w.dependsOn.every((d) => done.has(d) || !workflows.some((x) => x.key === d)));
    const pick = i >= 0 ? remaining.splice(i, 1)[0]! : remaining.shift()!;
    out.push(pick);
    done.add(pick.key);
  }
  return out;
}

function firstKeyCycle(graph: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    if (visiting.has(key)) {
      const start = stack.indexOf(key);
      return [...stack.slice(start), key];
    }
    if (visited.has(key)) return null;
    visiting.add(key);
    stack.push(key);
    for (const dependency of graph.get(key) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(key);
    visited.add(key);
    return null;
  };
  for (const key of graph.keys()) {
    const cycle = visit(key);
    if (cycle) return cycle;
  }
  return null;
}
