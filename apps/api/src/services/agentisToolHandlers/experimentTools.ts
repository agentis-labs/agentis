/**
 * Experiment tools (Agent-Native §3.5) — let an agent run A/B (or A/B/n) tests over
 * any decision, and read the success rate of each variant. General and domain-neutral.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerExperimentTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const svc = () => {
    if (!deps.experiments) throw new AgentisError('VALIDATION_FAILED', 'experiment service not configured');
    return deps.experiments;
  };
  registry.registerMany([
    {
      definition: {
        id: 'agentis.experiment.define',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description: 'Define (idempotently) an experiment: a decision you want to A/B test, with its variant arms. E.g. key "first_message", variants ["A","B","C"]. Re-defining updates the arms. Then use agentis.experiment.assign per subject and agentis.experiment.record on the outcome.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Stable experiment key, e.g. "first_message".' },
            variants: { type: 'array', items: { type: 'string' }, description: 'The arms, e.g. ["A","B"].' },
            appId: { type: 'string' },
          },
          required: ['key', 'variants'],
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const key = str(args.key);
        const variants = Array.isArray(args.variants) ? args.variants.filter((v): v is string => typeof v === 'string') : [];
        if (!key || variants.length < 2) throw new AgentisError('VALIDATION_FAILED', 'provide a key and at least 2 variants');
        const exp = svc().define({ workspaceId: ctx.workspaceId, key, variants, appId: typeof args.appId === 'string' ? args.appId : (ctx.appId ?? null) });
        return { experimentId: exp.id, key: exp.key, variants: exp.variantsJson };
      },
    },
    {
      definition: {
        id: 'agentis.experiment.assign',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description: 'Assign a subject (lead/contact/user id) to a variant of an experiment, and get the variant back. Sticky + deterministic: the same subject always gets the same arm. Use the returned variant to decide what to do (e.g. which message to send).',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Experiment key.' },
            subjectKey: { type: 'string', description: 'Stable subject identity (lead handle, contact id, …).' },
          },
          required: ['key', 'subjectKey'],
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const key = str(args.key);
        const subjectKey = str(args.subjectKey);
        const variant = svc().assign({ workspaceId: ctx.workspaceId, key, subjectKey });
        if (variant == null) throw new AgentisError('RESOURCE_NOT_FOUND', `no experiment "${key}" with variants — define it first with agentis.experiment.define`);
        return { key, subjectKey, variant };
      },
    },
    {
      definition: {
        id: 'agentis.experiment.record',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description: 'Record a subject\'s terminal outcome for an experiment (e.g. "won" / "lost"). Outcomes "won"/"success"/"positive"/"converted" count as a success in the rate. Call when the subject reaches a terminal state.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            subjectKey: { type: 'string' },
            outcome: { type: 'string', description: 'e.g. "won" or "lost".' },
          },
          required: ['key', 'subjectKey', 'outcome'],
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const recorded = svc().record({ workspaceId: ctx.workspaceId, key: str(args.key), subjectKey: str(args.subjectKey), outcome: str(args.outcome) });
        return { recorded };
      },
    },
    {
      definition: {
        id: 'agentis.experiment.results',
        family: 'inspect',
        mcpExposed: true,
        description: 'Read an experiment\'s per-variant results: how many subjects each arm got, their outcome counts, and the success rate of each — "the percentage of success of each".',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        mutating: false,
      },
      handler: (args, ctx) => {
        const results = svc().results(ctx.workspaceId, str(args.key));
        if (!results) throw new AgentisError('RESOURCE_NOT_FOUND', `no experiment "${str(args.key)}"`);
        return results;
      },
    },
  ]);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
