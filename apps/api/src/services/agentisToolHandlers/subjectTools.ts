/**
 * Subject tools (Agent-Native §3.2) — drive per-subject durable actors on the spine.
 *
 * An agent enrolls a subject (a lead, ticket, order…) with a declarative lifecycle
 * script; the Durable Entity dispatcher runs it — deterministic sends, agent steps,
 * and waits that park for a reply days later, out of order. `post` delivers an
 * external event (a reply) into a subject's inbox, waking it to advance.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerSubjectTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const svc = () => {
    if (!deps.durableEntities) throw new AgentisError('VALIDATION_FAILED', 'durable entity spine not configured');
    return deps.durableEntities;
  };
  registry.registerMany([
    {
      definition: {
        id: 'agentis.subject.enroll',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description: 'Enroll a subject (lead/ticket/order/…) as a durable actor on the spine, with a declarative lifecycle. Idempotent by key. The dispatcher runs it: `send` steps are deterministic/token-free, `agent` steps hand off to a model, `wait` steps park until agentis.subject.post delivers a reply (which may arrive days later, out of order). Script shape: { start, stages: { <name>: { action: "send"|"agent"|"wait"|"done", text?, instruction?, next? } } }. Use {{fact}} in text/instruction to interpolate the subject\'s facts.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Stable subject identity (e.g. a phone/handle/contact id).' },
            script: { type: 'object', description: 'The lifecycle: { start, stages }.' },
            facts: { type: 'object', description: 'Known facts about the subject (e.g. { connectionId, to, name }). Used by sends + interpolation.' },
            appId: { type: 'string' },
          },
          required: ['key', 'script'],
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        const script = args.script as { start?: string; stages?: Record<string, unknown> } | undefined;
        if (!key) throw new AgentisError('VALIDATION_FAILED', 'key is required');
        if (!script || typeof script.start !== 'string' || !script.stages || typeof script.stages !== 'object') {
          throw new AgentisError('VALIDATION_FAILED', 'script must be { start: string, stages: { ... } }');
        }
        if (!(script.start in script.stages)) throw new AgentisError('VALIDATION_FAILED', `script.start "${script.start}" is not a stage`);
        const facts = (args.facts && typeof args.facts === 'object' ? args.facts : {}) as Record<string, unknown>;
        const entity = svc().upsert({
          workspaceId: ctx.workspaceId,
          kind: 'subject',
          key,
          appId: typeof args.appId === 'string' ? args.appId : (ctx.appId ?? null),
          state: { script, stage: script.start, facts },
          nextWakeAt: new Date().toISOString(), // run the first stage on the next sweep
        });
        return { subjectId: entity.id, key, stage: script.start };
      },
    },
    {
      definition: {
        id: 'agentis.subject.post',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description: 'Deliver an external event (typically a reply) to a subject\'s inbox, waking it to advance past a `wait`. Route by subject key, or by the correlation token the subject is awaiting.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Subject key to deliver to.' },
            correlation: { type: 'object', description: 'Alternatively, route by { kind, id } to whichever subject awaits it.' },
            event: { type: 'string', description: 'Event type, e.g. "reply". Defaults to "reply".' },
            payload: { description: 'Event payload (e.g. the reply text/object).' },
          },
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const event = typeof args.event === 'string' && args.event.trim() ? args.event.trim() : 'reply';
        const s = svc();
        if (args.correlation && typeof args.correlation === 'object') {
          const c = args.correlation as { kind?: string; id?: string };
          if (c.kind && c.id) {
            const hit = s.postByCorrelation(ctx.workspaceId, { kind: c.kind, id: c.id }, event, args.payload);
            return { delivered: hit != null, subjectId: hit };
          }
        }
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        if (!key) throw new AgentisError('VALIDATION_FAILED', 'provide key or correlation {kind,id}');
        const entity = s.getByKey(ctx.workspaceId, 'subject', key);
        if (!entity) throw new AgentisError('RESOURCE_NOT_FOUND', `no subject "${key}"`);
        s.post(entity.id, event, args.payload);
        return { delivered: true, subjectId: entity.id };
      },
    },
    {
      definition: {
        id: 'agentis.subject.get',
        family: 'inspect',
        mcpExposed: true,
        description: 'Read a subject\'s current stage, facts, and pending inbox.',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        mutating: false,
      },
      handler: (args, ctx) => {
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        const s = svc();
        const entity = s.getByKey(ctx.workspaceId, 'subject', key);
        if (!entity) throw new AgentisError('RESOURCE_NOT_FOUND', `no subject "${key}"`);
        const state = entity.stateJson as { stage?: string; facts?: unknown };
        return { subjectId: entity.id, key, status: entity.status, stage: state?.stage, facts: state?.facts ?? {}, pendingInbox: s.pendingInbox(entity.id).length };
      },
    },
    {
      definition: {
        id: 'agentis.subject.list',
        family: 'inspect',
        mcpExposed: true,
        description: 'List the subjects in this workspace with their current stage + status (the pipeline).',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
      },
      handler: (_args, ctx) => ({
        subjects: svc().listByKind(ctx.workspaceId, 'subject').map((e) => {
          const state = e.stateJson as { stage?: string };
          return { subjectId: e.id, key: e.key, status: e.status, stage: state?.stage ?? null };
        }),
      }),
    },
  ]);
}
