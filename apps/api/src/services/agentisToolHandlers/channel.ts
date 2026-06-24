import { AgentisError } from '@agentis/core';
import type { ChannelKind } from '../../adapters/channels/types.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

const CHANNEL_KINDS = new Set<ChannelKind>(['telegram', 'discord', 'slack', 'whatsapp']);

export function registerChannelTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.channel.list',
        family: 'inspect',
        description: 'List native Agentis messaging channels and their health. Use before sending to Telegram, WhatsApp, Slack, or Discord.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...CHANNEL_KINDS] },
            status: { type: 'string' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const kind = parseKind(args.kind);
        const status = typeof args.status === 'string' ? args.status : null;
        const channels = deps.channels
          .list(ctx.workspaceId)
          .filter((connection) => !kind || connection.kind === kind)
          .filter((connection) => !status || connection.status === status)
          .map((connection) => ({
            id: connection.id,
            kind: connection.kind,
            name: connection.name,
            status: connection.status,
            mode: connection.mode,
            transport: connection.transport,
            defaultChatId: connection.defaultChatId,
            targetAliases: connection.targetAliases,
            health: connection.health,
            lastError: connection.lastError,
          }));
        return { count: channels.length, channels };
      },
    },
    {
      definition: {
        id: 'agentis.channel.send',
        family: 'run',
        description: 'Send a message through a native Agentis channel connection. WhatsApp accepts explicit phone numbers with country code (for example +12345678901) or WhatsApp JIDs; "default" uses the saved default target.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Specific channel connection id. Optional when kind resolves to one active channel.' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS], description: 'Channel kind to use when connectionId is omitted.' },
            to: { type: 'string', description: 'Channel destination. Use "default" or omit for the saved default target. WhatsApp may be a phone number, JID, or saved alias.' },
            body: { type: 'string', description: 'Message body to send.' },
          },
          required: ['body'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const body = typeof args.body === 'string' ? args.body.trim() : '';
        if (!body) throw new AgentisError('VALIDATION_FAILED', 'body is required');
        const kind = parseKind(args.kind);
        const connectionId = typeof args.connectionId === 'string' && args.connectionId.trim()
          ? args.connectionId.trim()
          : null;
        const requestedTo = typeof args.to === 'string' ? args.to.trim() : '';

        const connections = deps.channels.list(ctx.workspaceId);
        const candidate = connectionId
          ? connections.find((connection) => connection.id === connectionId)
          : resolveCandidate(connections, kind, requestedTo);
        if (!candidate) {
          const filtered = connections
            .filter((connection) => !kind || connection.kind === kind)
            .map((connection) => ({
              id: connection.id,
              kind: connection.kind,
              name: connection.name,
              status: connection.status,
              defaultChatId: connection.defaultChatId,
              targetAliases: connection.targetAliases,
              healthStatus: connection.health.status,
            }));
          return {
            sent: false,
            errorCode: 'CHANNEL_TARGET_AMBIGUOUS_OR_MISSING',
            error: requestedTo && !isMe(requestedTo)
              ? 'No single active channel matched the explicit destination. Provide connectionId when more than one connection is active.'
              : 'No single active channel with a default target matched. Provide connectionId, destination, or configure a default recipient.',
            candidates: filtered,
          };
        }

        const resolved = deps.channels.resolveDestination({ connectionId: candidate.id, to: requestedTo || null });
        const chatId = resolved.chatId;
        if (!chatId) {
          return {
            sent: false,
            errorCode: 'CHANNEL_DEFAULT_TARGET_MISSING',
            error: `${candidate.kind} connection '${candidate.name}' has no saved default target.`,
            remediation: candidate.kind === 'whatsapp'
              ? 'Provide a WhatsApp phone number/JID in "to", or save a default recipient for "default".'
              : 'Send a first inbound message or save a default chat/recipient ID.',
            connection: {
              id: candidate.id,
              kind: candidate.kind,
              status: candidate.status,
              health: candidate.health,
            },
          };
        }

        await deps.channels.deliverToConnection({ connectionId: candidate.id, chatId, body });
        return {
          sent: true,
          connectionId: candidate.id,
          kind: candidate.kind,
          to: chatId,
          targetSource: resolved.source,
          status: candidate.status,
        };
      },
    },
  ]);
}

function parseKind(value: unknown): ChannelKind | null {
  if (typeof value !== 'string') return null;
  return CHANNEL_KINDS.has(value as ChannelKind) ? value as ChannelKind : null;
}

function resolveCandidate(
  connections: ReturnType<NonNullable<ToolHandlerDeps['channels']>['list']>,
  kind: ChannelKind | null,
  to: string,
) {
  const active = connections.filter((connection) => connection.status === 'active' && (!kind || connection.kind === kind));
  if (to && !isMe(to)) {
    return active.length === 1 ? active[0] : null;
  }
  const withDefault = active.filter((connection) => Boolean(connection.defaultChatId));
  return withDefault.length === 1 ? withDefault[0] : null;
}

function isMe(value: string): boolean {
  return /^(me|default)$/i.test(value.trim());
}
