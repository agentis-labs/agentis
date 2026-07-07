/**
 * Conversation-script tool family (GAP B1/B3) — a GENERAL primitive: lets an agent
 * install and start a per-contact conversation state machine on ANY App (support,
 * booking, onboarding, surveys, reminders, sales, moderation, any channel), instead
 * of improvising the whole thing with datastore bookkeeping and a full agent turn
 * per message. Nothing here is tied to a use case.
 *
 *   agentis.conversation.define  — install the App's script (stages + transitions).
 *   agentis.conversation.enroll  — start one contact (the first outbound touch).
 *
 * The dispatcher then advances each enrolled contact automatically on every inbound
 * reply; deterministic stages (e.g. the timed greeting) cost ZERO tokens.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolContext } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

function resolveAppId(args: Record<string, unknown>, ctx: AgentisToolContext): string {
  const appId = (typeof args.appId === 'string' && args.appId.trim()) || ctx.appId;
  if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (pass appId, or call from an App surface)');
  return appId;
}

export function registerConversationTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.conversation.define',
        family: 'build',
        mcpExposed: true,
        description:
          'Install a per-contact CONVERSATION SCRIPT on an App — a declarative state machine the channel '
          + 'dispatcher advances automatically on each inbound reply (the platform primitive for "send → await '
          + 'their reply → branch → run a workflow → stop"). Prefer this over hand-writing stage bookkeeping. '
          + 'Each stage has an `entry` (send_deterministic = templated, ZERO tokens, supports {greeting} + '
          + '{facts.x}; send_agent = a small model composes one message; run_workflow = trigger a workflow and '
          + 'rest until it completes; none) and a transition (`onReply`: goto | classify→branches; `onComplete`: '
          + 'goto for run_workflow). Mark the final stage `terminal:true` to STOP. Contacts persist to the '
          + '`contactCollection` (a DataBoard can render the pipeline).',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'Target App (optional when on an App surface).' },
            script: {
              type: 'object',
              description:
                'ConversationScript: { initialStage, contactCollection?, stages: [{ id, label?, entry?, onReply?, onComplete?, terminal? }] }. '
                + 'entry.kind ∈ send_deterministic{template} | send_agent{brief,attachFrom?} | run_workflow{workflowId,inputsFrom?} | none. '
                + 'onReply.kind ∈ goto{stage} | classify{brief,labels[],branches{label:stage}}.',
            },
          },
          required: ['script'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.conversation) throw new AgentisError('VALIDATION_FAILED', 'conversation runtime not configured');
        const appId = resolveAppId(args, ctx);
        const result = deps.conversation.define({ workspaceId: ctx.workspaceId, appId }, args.script);
        return {
          ...result,
          message:
            `Script installed on the App (${result.stages} stage(s)). Contacts persist to "${result.contactCollection}". `
            + 'Next: enroll a contact with agentis.conversation.enroll to start the outbound flow; inbound replies then advance the script automatically.',
        };
      },
    },
    {
      definition: {
        id: 'agentis.conversation.enroll',
        family: 'run',
        mcpExposed: true,
        description:
          'Start ONE contact through the App\'s conversation script — the outbound first touch (e.g. the deterministic '
          + 'greeting). The contact then advances automatically as they reply. Provide the channel address (WhatsApp '
          + 'phone/JID, …) and the connection to reach them on.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'Target App (optional when on an App surface).' },
            address: { type: 'string', description: 'Contact channel address — WhatsApp phone (+55…) or JID, Telegram chat id, etc.' },
            connectionId: { type: 'string', description: 'Channel connection to reach the contact on. Optional when exactly one channel is active.' },
            kind: { type: 'string', description: 'Channel kind to auto-resolve the connection (e.g. "whatsapp") when connectionId is omitted.' },
            facts: { type: 'object', description: 'Personalization facts for the contact (e.g. { instagram, brand, mockup }). Used by send_agent stages + inputsFrom.' },
          },
          required: ['address'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.conversation) throw new AgentisError('VALIDATION_FAILED', 'conversation runtime not configured');
        const appId = resolveAppId(args, ctx);
        const address = String(args.address ?? '').trim();
        if (!address) throw new AgentisError('VALIDATION_FAILED', 'address is required');
        const connectionId = resolveConnectionId(args, deps, ctx.workspaceId);
        const facts = args.facts && typeof args.facts === 'object' && !Array.isArray(args.facts) ? (args.facts as Record<string, unknown>) : undefined;
        const result = await deps.conversation.enroll(
          { workspaceId: ctx.workspaceId, appId, userId: ctx.userId, ambientId: ctx.ambientId ?? null },
          address,
          connectionId,
          facts,
        );
        return { ...result, address, connectionId };
      },
    },
  ]);
}

/** Explicit connectionId, else the single active channel (optionally filtered by kind). */
function resolveConnectionId(args: Record<string, unknown>, deps: ToolHandlerDeps, workspaceId: string): string {
  const explicit = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
  if (explicit) return explicit;
  if (!deps.channels) throw new AgentisError('VALIDATION_FAILED', 'no channel bridge configured; pass connectionId');
  const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
  const active = deps.channels
    .list(workspaceId)
    .filter((c) => c.status === 'active' && (!kind || c.kind === kind));
  if (active.length === 1) return active[0]!.id;
  throw new AgentisError(
    'VALIDATION_FAILED',
    active.length === 0 ? 'no active channel to enroll on; connect one or pass connectionId' : 'multiple active channels; pass connectionId (or kind) to disambiguate',
  );
}
