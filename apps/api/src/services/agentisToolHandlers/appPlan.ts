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
});

const appPlanSchema = z.object({
  appId: z.string().optional(),
  name: z.string().optional(),
  intent: z.string().min(1),
  workflows: z.array(planWorkflowSchema).default([]),
  /** True when the App drives a per-contact outreach conversation (→ define a script). */
  conversation: z.boolean().default(false),
  collections: z.array(z.object({ name: z.string().min(1), purpose: z.string().optional() })).default([]),
  cast: z.array(z.object({ role: z.string().min(1), name: z.string().optional() })).default([]),
  policy: z
    .object({
      maxPerHour: z.number().int().positive().optional(),
      quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).optional(),
    })
    .optional(),
});

interface ChecklistStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  why: string;
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
          + 'You enumerate: the workflows (each with a purpose + dependsOn), whether it needs a per-contact conversation '
          + 'script, the datastore collections, the resident cast, and the outbound policy (rate/quiet-hours). It ensures '
          + 'the App, applies the policy, records the blueprint, and returns the exact next calls IN ORDER '
          + '(build each workflow → SWIFT-verify it → define the script → …). Then execute the checklist.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'Existing App to plan into (optional — a shell App is created from `name` otherwise).' },
            name: { type: 'string', description: 'App name when creating a new one.' },
            intent: { type: 'string', description: 'What this App is for, in one or two sentences.' },
            workflows: {
              type: 'array',
              description: 'The distinct automation subroutines. Each: { key, title, purpose, dependsOn?: [keys], trigger? }.',
              items: { type: 'object' },
            },
            conversation: { type: 'boolean', description: 'True when the App runs a per-contact outreach script (→ agentis.conversation.define).' },
            collections: { type: 'array', description: 'Datastore collections: [{ name, purpose }].', items: { type: 'object' } },
            cast: { type: 'array', description: 'Resident specialists: [{ role, name? }] (operator + workers).', items: { type: 'object' } },
            policy: { type: 'object', description: 'Outbound safety envelope: { maxPerHour?, quietHours?: { start, end } }.' },
          },
          required: ['intent'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (rawArgs, ctx) => {
        const args = appPlanSchema.parse(rawArgs);
        const stores = buildAppStores({ db: deps.db, bus: deps.bus });
        const appId = ensureApp(stores, args, ctx);

        // Apply the outbound safety envelope now (the agent rarely sets it later).
        if (args.policy) {
          try {
            stores.store.update(ctx.workspaceId, appId, { policy: { outbound: args.policy } });
          } catch (err) {
            deps.logger.warn('app.plan.policy_failed', { appId, err: (err as Error).message });
          }
        }

        // Record the blueprint (best-effort) so the plan is durable + inspectable.
        try {
          const existing = new Set(stores.data.listCollections(ctx.workspaceId, appId).map((c) => c.name));
          if (!existing.has('app_blueprint')) {
            stores.data.defineCollection(ctx.workspaceId, appId, {
              name: 'app_blueprint',
              schema: { fields: [{ key: 'key', type: 'string', required: true, indexed: true }] },
            });
          }
          stores.data.upsert(ctx.workspaceId, appId, 'app_blueprint', { key: 'blueprint' }, { key: 'blueprint', blueprint: args, updatedAt: new Date().toISOString() });
        } catch (err) {
          deps.logger.warn('app.plan.blueprint_persist_failed', { appId, err: (err as Error).message });
        }

        const checklist = buildChecklist(appId, args);
        return {
          appId,
          intent: args.intent,
          parts: {
            workflows: args.workflows.length,
            conversation: args.conversation,
            collections: args.collections.length,
            cast: args.cast.length,
            policy: Boolean(args.policy),
          },
          checklist,
          message:
            `App plan recorded (${args.workflows.length} workflow(s)${args.conversation ? ' + a conversation script' : ''}). `
            + 'Now EXECUTE the checklist in order: build each workflow and SWIFT-verify it (dry_run → debug → verdict) '
            + 'before moving on; then wire the senses (script/triggers). Do not collapse these into one workflow.',
          compass: { stage: 'authored' as const, summary: 'App decomposed into parts. Execute the checklist top-to-bottom.', next: checklist.slice(0, 1).map(({ tool, args: a, why }) => ({ tool, args: a, why })) },
        };
      },
    },
  ]);
}

function ensureApp(stores: ReturnType<typeof buildAppStores>, args: z.infer<typeof appPlanSchema>, ctx: AgentisToolContext): string {
  const appId = (args.appId && args.appId.trim()) || ctx.appId;
  if (appId) return appId;
  if (!args.name?.trim()) throw new AgentisError('VALIDATION_FAILED', 'app.plan needs an appId or a name to create the App');
  const app = stores.store.create(ctx.workspaceId, ctx.userId, { name: args.name.trim(), description: args.intent.slice(0, 400) });
  return app.id;
}

/** Ordered next calls: dependency-respecting workflow builds, then the script + collections. */
function buildChecklist(appId: string, args: z.infer<typeof appPlanSchema>): ChecklistStep[] {
  const steps: ChecklistStep[] = [];
  let n = 1;
  for (const wf of orderByDependsOn(args.workflows)) {
    steps.push({
      step: n++,
      tool: 'agentis.build_workflow',
      args: { description: `${wf.title}: ${wf.purpose}`, newWorkflow: true },
      why: `Author the "${wf.key}" part${wf.dependsOn.length ? ` (runs after: ${wf.dependsOn.join(', ')})` : ''}, then SWIFT-verify it (dry_run → debug → verdict) before the next.`,
    });
  }
  for (const col of args.collections) {
    steps.push({ step: n++, tool: 'agentis.data.define_collection', args: { appId, name: col.name }, why: col.purpose ?? `Datastore collection "${col.name}".` });
  }
  if (args.conversation) {
    steps.push({
      step: n++,
      tool: 'agentis.conversation.define',
      args: { appId },
      why: 'Install the per-contact outreach script (deterministic greeting → agent pitch → classify → run_workflow → terminal stop) — the platform primitive for await-reply, token-free where scripted. Do NOT hand-roll this with an agent loop.',
    });
  }
  return steps;
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
