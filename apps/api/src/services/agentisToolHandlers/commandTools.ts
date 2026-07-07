/**
 * Command tools — active use of the manager's mind (COMMAND-MODEL Layer B).
 *
 *   agentis.command.review → refresh the scoped Command Model (inventory +
 *     progress + deltas since last look + App-mind learnings) and stamp the
 *     review watermark. The on-demand comprehension refresh.
 *   agentis.command.note   → write a decision/objective/progress/learning back to
 *     the agent's own mind, so comprehension COMPOUNDS across sessions instead of
 *     resetting each turn. This is the fix for "agents don't use their minds".
 */

import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { formatBriefing } from '../commandModel.js';

const NOTE_KINDS = ['decision', 'objective', 'progress', 'learning'];

export function registerCommandTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany(
    [
      {
        definition: {
          id: 'agentis.command.review',
          family: 'inspect',
          mcpExposed: true,
          description:
            'Review what YOU manage right now — your scoped inventory, live progress and what changed since you last looked, what needs you, and what your apps have learned (App minds). Call this at the start of a management turn or whenever you want a fresh picture, BEFORE acting. Stamps your review watermark so next time surfaces only new movement.',
          inputSchema: { type: 'object', properties: {} },
          mutating: false,
        },
        handler: async (_args, ctx) => {
          if (!deps.commandModel) return { available: false, note: 'command model is unavailable' };
          if (!ctx.agentId) return { available: false, note: 'command.review runs as a specific agent — no agent identity on this call.' };
          const model = deps.commandModel.build(ctx.workspaceId, ctx.agentId);
          deps.commandModel.markReviewed(ctx.workspaceId, ctx.agentId);
          return {
            available: true,
            role: model.scope.kind,
            manages: model.inventory,
            progress: model.progress,
            appLearnings: model.appLearnings,
            briefing: formatBriefing(model),
          };
        },
      },
      {
        definition: {
          id: 'agentis.residency.remember',
          family: 'run',
          mcpExposed: true,
          autoExecute: true,
          description:
            'Persist your working state as a RESIDENT agent (Agent-Native §3.1) so your NEXT scheduled wake continues where you left off instead of starting over. Save your current plan and/or a short note on where you left off — the resident wake injects both back into your context automatically.',
          inputSchema: {
            type: 'object',
            properties: {
              plan: { type: 'string', description: 'Your current standing plan / objective.' },
              observations: { type: 'string', description: 'Where you left off — the state your next wake needs to continue.' },
            },
          },
          mutating: true,
        },
        handler: (args, ctx) => {
          if (!deps.sessionStore) return { saved: false, note: 'resident session store unavailable' };
          if (!ctx.agentId) return { saved: false, note: 'residency.remember runs as a specific agent — no agent identity on this call.' };
          const patch: { plan?: string; observations?: string } = {};
          if (typeof args.plan === 'string') patch.plan = args.plan;
          if (typeof args.observations === 'string') patch.observations = args.observations;
          if (patch.plan === undefined && patch.observations === undefined) return { saved: false, note: 'provide plan and/or observations' };
          deps.sessionStore.rememberResident(ctx.workspaceId, ctx.agentId, patch);
          return { saved: true };
        },
      },
      {
        definition: {
          id: 'agentis.command.note',
          family: 'run',
          mcpExposed: true,
          autoExecute: true,
          description:
            'Record a management decision, objective, progress note, or learning to YOUR mind so your future self (and next session) recalls it. Use this as you manage — it is how comprehension compounds instead of resetting each turn. Recalled automatically in later turns and by agentis.memory.read.',
          inputSchema: {
            type: 'object',
            properties: {
              note: { type: 'string', description: 'The decision/objective/progress/learning, in your own words.' },
              kind: { type: 'string', enum: NOTE_KINDS, description: 'What kind of note (default decision).' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['note'],
          },
          mutating: true,
        },
        handler: async (args, ctx) => {
          if (!deps.memory) throw new Error('workspace memory (your mind) is unavailable');
          const note = String(args.note ?? '').trim();
          if (!note) throw new Error('note is required');
          const kind = typeof args.kind === 'string' && NOTE_KINDS.includes(args.kind) ? args.kind : 'decision';
          const title = `Command ${kind}: ${note.split(/\s+/).slice(0, 9).join(' ')}`.slice(0, 88);
          const extraTags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : [];
          const id = deps.memory.write({
            workspaceId: ctx.workspaceId,
            scopeId: ctx.agentId ?? null,
            // Cast mirrors agentis.memory.write — the store maps unknown kinds to a
            // canonical episode type at write time (KIND_TO_TYPE fallback).
            kind: 'note' as Parameters<NonNullable<typeof deps.memory>['write']>[0]['kind'],
            source: 'agent',
            title,
            content: note,
            importance: kind === 'objective' ? 0.75 : 0.6,
            tags: ['command', kind, ...extraTags],
          });
          return { id, kind, title, status: 'recorded', message: `Recorded to your mind — you will recall "${title}" in future turns.` };
        },
      },
    ],
    { defaultMcpExposed: true },
  );
}
