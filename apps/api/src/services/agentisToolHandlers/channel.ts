import { AgentisError } from '@agentis/core';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { ChannelKind, OutboundAttachmentRef } from '../../adapters/channels/types.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { resolveAndSend } from '../conversation/channelSend.js';

const CHANNEL_KINDS = new Set<ChannelKind>(['telegram', 'discord', 'slack', 'whatsapp', 'voice']);

/** One attachment item — shared by the top-level `attachments` and each `messages[]` entry. */
const ATTACHMENT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'artifact:<id>, data: URL, or http(s) URL.' },
    artifactId: { type: 'string', description: 'Artifact id (alternative to url).' },
    filename: { type: 'string' },
    mimeType: { type: 'string' },
    kind: { type: 'string', enum: ['image', 'video', 'audio', 'voice', 'sticker', 'file'], description: 'Delivery hint; inferred from MIME type when omitted. "voice" = a push-to-talk voice note (OGG/Opus mono for WhatsApp); "sticker" = WebP.' },
    caption: { type: 'string', description: 'Per-attachment caption.' },
  },
} as const;

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
            appId: connection.appId,
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
        id: 'agentis.connection.bind_app',
        family: 'run',
        description: 'Bind a native channel connection to an Agentic App so inbound conversations run in that App context. Pass appId:null to unbind. Both resources must belong to this workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            appId: { type: ['string', 'null'], description: 'App id to bind, or null to clear the binding.' },
          },
          required: ['connectionId', 'appId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
        if (!connectionId) throw new AgentisError('VALIDATION_FAILED', 'connectionId is required');
        const appId = args.appId === null ? null : typeof args.appId === 'string' ? args.appId.trim() : '';
        if (appId === '') throw new AgentisError('VALIDATION_FAILED', 'appId must be a non-empty App id or null');

        const connection = deps.db.select({ agentId: schema.channelConnections.agentId })
          .from(schema.channelConnections)
          .where(and(
            eq(schema.channelConnections.id, connectionId),
            eq(schema.channelConnections.workspaceId, ctx.workspaceId),
          )).get();
        if (!connection) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${connectionId} not found`);
        if (ctx.agentId && deps.connectionGrants) {
          const decision = deps.connectionGrants.authorize({
            workspaceId: ctx.workspaceId,
            connectionId,
            agentId: ctx.agentId,
            required: 'manage',
            ownerAgentId: connection.agentId,
          });
          if (!decision.ok) throw new AgentisError('CONNECTION_SCOPE_MISSING', decision.reason ?? 'manage access to this connection is required');
        }
        const bound = deps.channels.bindApp(ctx.workspaceId, connectionId, appId);
        return {
          bound: appId !== null,
          connectionId: bound.id,
          appId: bound.appId,
          message: appId ? `Channel is now bound to App ${appId}.` : 'Channel App binding was cleared.',
        };
      },
    },
    {
      definition: {
        id: 'agentis.channel.send',
        family: 'run',
        description: 'Send a message — optionally with media attachments, or a natural burst of several messages — through a native Agentis channel connection. Media kinds: image, video, audio, voice note, sticker, file. WhatsApp accepts explicit phone numbers with country code (for example +12345678901) or WhatsApp JIDs; "default" uses the saved default target. To send a screenshot, first call agentis.browser.screenshot and pass its `ref` (e.g. "artifact:<id>") as an attachment url. Use `messages[]` to send several messages in sequence (e.g. a photo, then a follow-up line).',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Specific channel connection id. Optional when kind resolves to one active channel.' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS], description: 'Channel kind to use when connectionId is omitted.' },
            to: { type: 'string', description: 'Channel destination. Use "default" or omit for the saved default target. WhatsApp may be a phone number, JID, or saved alias.' },
            body: { type: 'string', description: 'Message body / caption. May be empty when sending attachments only. Ignored when messages[] is provided.' },
            attachments: {
              type: 'array',
              description: 'Media to deliver. Each item points at one source: an artifact ("artifact:<id>" or artifactId), a data: URL, or an http(s) URL.',
              items: ATTACHMENT_ITEM_SCHEMA,
            },
            messages: {
              type: 'array',
              description: 'Send these as a natural burst, in order, to the same destination. Each item is its own message with an optional body and attachments. When set, top-level body/attachments are ignored.',
              items: {
                type: 'object',
                properties: {
                  body: { type: 'string' },
                  attachments: { type: 'array', items: ATTACHMENT_ITEM_SCHEMA },
                },
              },
            },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        // Shared resolve→authorize→deliver flow (same one the deterministic
        // `channel` workflow node uses) so tool and node behave identically.
        return resolveAndSend(
          { channels: deps.channels, ...(deps.connectionGrants ? { connectionGrants: deps.connectionGrants } : {}) },
          {
            workspaceId: ctx.workspaceId,
            body: typeof args.body === 'string' ? args.body : '',
            kind: typeof args.kind === 'string' ? args.kind : null,
            connectionId: typeof args.connectionId === 'string' ? args.connectionId : null,
            to: typeof args.to === 'string' ? args.to : null,
            agentId: ctx.agentId ?? null,
            attachments: parseAttachments(args.attachments),
            ...(Array.isArray(args.messages) ? { messages: parseMessages(args.messages) } : {}),
          },
        );
      },
    },
    {
      definition: {
        id: 'agentis.channel.capabilities',
        family: 'inspect',
        description: 'Report what a channel connection can send (media kinds, reactions, typing/presence, location, contacts, polls, quoted replies, mentions, bursts, human-like pacing). Call before composing rich content so you only attempt what the channel supports.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Connection to inspect. Optional when kind resolves to one active channel.' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS], description: 'Channel kind (used when connectionId is omitted).' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = resolveConnectionId(deps.channels, ctx.workspaceId, args);
        if (!connectionId) throw new AgentisError('RESOURCE_NOT_FOUND', 'no matching channel connection; pass connectionId or a kind with exactly one active connection');
        const capabilities = deps.channels.capabilitiesFor(connectionId);
        if (!capabilities) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${connectionId} not found`);
        return { connectionId, capabilities };
      },
    },
    {
      definition: {
        id: 'agentis.channel.typing',
        family: 'run',
        description: 'Show or clear a "typing…" indicator in a channel chat (best-effort; supported on WhatsApp/Telegram live sessions). Use to make a reply feel human before sending.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS] },
            to: { type: 'string', description: 'Destination chat (phone/JID/chat id, or "default").' },
            on: { type: 'boolean', description: 'true = show typing, false = clear. Defaults to true.' },
          },
          required: ['to'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = resolveConnectionId(deps.channels, ctx.workspaceId, args);
        if (!connectionId) throw new AgentisError('RESOURCE_NOT_FOUND', 'no matching channel connection');
        const resolved = deps.channels.resolveDestination({ connectionId, to: typeof args.to === 'string' ? args.to : null });
        if (!resolved.chatId) throw new AgentisError('VALIDATION_FAILED', 'no destination chat resolved for typing');
        await deps.channels.setTyping(connectionId, resolved.chatId, args.on !== false);
        return { ok: true, connectionId, to: resolved.chatId, typing: args.on !== false };
      },
    },
    {
      definition: {
        id: 'agentis.channel.react',
        family: 'run',
        description: 'Add or clear an emoji reaction on a prior message in a channel chat (best-effort; WhatsApp live sessions). Pass an empty emoji to clear.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS] },
            to: { type: 'string', description: 'Destination chat (phone/JID/chat id, or "default").' },
            messageId: { type: 'string', description: 'Provider message id of the message to react to.' },
            emoji: { type: 'string', description: 'Reaction emoji, or "" to clear.' },
          },
          required: ['to', 'messageId', 'emoji'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.channels) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
        const connectionId = resolveConnectionId(deps.channels, ctx.workspaceId, args);
        if (!connectionId) throw new AgentisError('RESOURCE_NOT_FOUND', 'no matching channel connection');
        const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
        if (!messageId) throw new AgentisError('VALIDATION_FAILED', 'messageId is required');
        const resolved = deps.channels.resolveDestination({ connectionId, to: typeof args.to === 'string' ? args.to : null });
        if (!resolved.chatId) throw new AgentisError('VALIDATION_FAILED', 'no destination chat resolved for reaction');
        await deps.channels.reactToMessage(connectionId, resolved.chatId, messageId, typeof args.emoji === 'string' ? args.emoji : '');
        return { ok: true, connectionId, to: resolved.chatId, messageId };
      },
    },
    {
      definition: {
        id: 'agentis.connection.grants',
        family: 'inspect',
        description: 'Inspect per-agent authority over connections (Agent-Native §3.3). List the grants governing a connection, the grants YOU hold, or pending requests awaiting operator approval.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'List grants governing this connection.' },
            mine: { type: 'boolean', description: 'List the grants the calling agent holds.' },
            pending: { type: 'boolean', description: 'List requests awaiting operator approval.' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.connectionGrants) throw new AgentisError('CONNECTION_GRANTS_UNAVAILABLE', 'connection grant service not configured');
        if (args.pending) return { requests: deps.connectionGrants.listRequests(ctx.workspaceId) };
        if (args.mine && ctx.agentId) return { grants: deps.connectionGrants.listForAgent(ctx.workspaceId, ctx.agentId) };
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
        if (connectionId) return { grants: deps.connectionGrants.list(ctx.workspaceId, connectionId) };
        return { grants: ctx.agentId ? deps.connectionGrants.listForAgent(ctx.workspaceId, ctx.agentId) : [] };
      },
    },
    {
      definition: {
        id: 'agentis.connection.request',
        family: 'run',
        description: 'Capability negotiation (Agent-Native §3.3): request authority to use a connection you do not yet own — e.g. "I need to send on WhatsApp to run this outreach". Records an operator-approved request; does NOT grant access itself.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Connection to request access to.' },
            connectionKind: { type: 'string', enum: ['channel', 'credential', 'mcp'], description: 'Resource family. Defaults to channel.' },
            scope: { type: 'string', enum: ['read', 'send', 'manage'], description: 'Least-privilege scope needed. Defaults to send.' },
            reason: { type: 'string', description: 'Why you need it — surfaced to the operator.' },
          },
          required: ['connectionId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.connectionGrants) throw new AgentisError('CONNECTION_GRANTS_UNAVAILABLE', 'connection grant service not configured');
        if (!ctx.agentId) throw new AgentisError('VALIDATION_FAILED', 'connection.request must be called by an agent (no agent context)');
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
        if (!connectionId) throw new AgentisError('VALIDATION_FAILED', 'connectionId is required');
        const grant = deps.connectionGrants.request({
          workspaceId: ctx.workspaceId,
          connectionKind: parseConnectionKind(args.connectionKind),
          connectionId,
          agentId: ctx.agentId,
          scope: parseScope(args.scope),
          note: typeof args.reason === 'string' ? args.reason.trim() : null,
          grantedBy: ctx.agentId,
        });
        return { requested: true, grantId: grant.id, status: 'requested', message: 'Operator approval pending. The operator grants it with agentis.connection.grant.' };
      },
    },
    {
      definition: {
        id: 'agentis.connection.grant',
        family: 'run',
        description: 'Operator action (Agent-Native §3.3): grant an agent scoped authority over a connection, or approve a pending request. Once any grant exists on a connection, only granted agents (plus its owner) may use it.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            agentId: { type: 'string', description: 'Agent to authorize.' },
            connectionKind: { type: 'string', enum: ['channel', 'credential', 'mcp'] },
            scope: { type: 'string', enum: ['read', 'send', 'manage'], description: 'Defaults to send.' },
            expiresAt: { type: 'string', description: 'Optional ISO expiry.' },
          },
          required: ['connectionId', 'agentId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.connectionGrants) throw new AgentisError('CONNECTION_GRANTS_UNAVAILABLE', 'connection grant service not configured');
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
        const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
        if (!connectionId || !agentId) throw new AgentisError('VALIDATION_FAILED', 'connectionId and agentId are required');
        const grant = deps.connectionGrants.grant({
          workspaceId: ctx.workspaceId,
          connectionKind: parseConnectionKind(args.connectionKind),
          connectionId,
          agentId,
          scope: parseScope(args.scope),
          grantedBy: ctx.userId,
          expiresAt: typeof args.expiresAt === 'string' ? args.expiresAt : null,
        });
        return { granted: true, grantId: grant.id, agentId, scope: grant.scope };
      },
    },
  ]);
}

function parseScope(value: unknown): 'read' | 'send' | 'manage' {
  return value === 'read' || value === 'manage' ? value : 'send';
}

function parseConnectionKind(value: unknown): 'channel' | 'credential' | 'mcp' {
  return value === 'credential' || value === 'mcp' ? value : 'channel';
}

/** Normalize loosely-typed attachment args into typed references. */
function parseAttachments(value: unknown): OutboundAttachmentRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AgentisError('VALIDATION_FAILED', 'attachments must be an array');
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AgentisError('VALIDATION_FAILED', `attachment[${i}] must be an object`);
    }
    const obj = raw as Record<string, unknown>;
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    const artifactId = typeof obj.artifactId === 'string' ? obj.artifactId.trim() : '';
    if (!url && !artifactId) throw new AgentisError('VALIDATION_FAILED', `attachment[${i}] needs a url or artifactId`);
    const ref: OutboundAttachmentRef = {};
    if (url) ref.url = url;
    if (artifactId) ref.artifactId = artifactId;
    if (typeof obj.filename === 'string' && obj.filename.trim()) ref.filename = obj.filename.trim();
    if (typeof obj.mimeType === 'string' && obj.mimeType.trim()) ref.mimeType = obj.mimeType.trim();
    if (obj.kind === 'image' || obj.kind === 'video' || obj.kind === 'audio' || obj.kind === 'voice' || obj.kind === 'sticker' || obj.kind === 'file') ref.kind = obj.kind;
    if (typeof obj.caption === 'string' && obj.caption.trim()) ref.caption = obj.caption.trim();
    return ref;
  });
}

/** Normalize a burst of loosely-typed messages into typed send messages. */
function parseMessages(value: unknown): { body?: string; attachments?: OutboundAttachmentRef[] }[] {
  if (!Array.isArray(value)) throw new AgentisError('VALIDATION_FAILED', 'messages must be an array');
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AgentisError('VALIDATION_FAILED', `messages[${i}] must be an object`);
    }
    const obj = raw as Record<string, unknown>;
    const message: { body?: string; attachments?: OutboundAttachmentRef[] } = {};
    if (typeof obj.body === 'string') message.body = obj.body;
    if (obj.attachments != null) message.attachments = parseAttachments(obj.attachments);
    return message;
  });
}

function parseKind(value: unknown): ChannelKind | null {
  if (typeof value !== 'string') return null;
  return CHANNEL_KINDS.has(value as ChannelKind) ? value as ChannelKind : null;
}

/** Resolve a connection id from explicit id, or a kind that maps to one active/default connection. */
function resolveConnectionId(
  channels: NonNullable<ToolHandlerDeps['channels']>,
  workspaceId: string,
  args: { connectionId?: unknown; kind?: unknown },
): string | null {
  const explicit = typeof args.connectionId === 'string' && args.connectionId.trim() ? args.connectionId.trim() : '';
  if (explicit) return explicit;
  const kind = parseKind(args.kind);
  const active = channels.list(workspaceId).filter((c) => c.status === 'active' && (!kind || c.kind === kind));
  if (active.length === 1) return active[0]!.id;
  if (kind) {
    const defaultId = channels.defaultConnectionFor(workspaceId, kind);
    if (defaultId) return defaultId;
  }
  return null;
}

