import { AgentisError } from '@agentis/core';
import type { ChannelKind, OutboundAttachmentRef } from '../../adapters/channels/types.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { resolveAndSend } from '../conversation/channelSend.js';

const CHANNEL_KINDS = new Set<ChannelKind>(['telegram', 'discord', 'slack', 'whatsapp', 'voice']);

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
        description: 'Send a message — optionally with image/file attachments — through a native Agentis channel connection. WhatsApp accepts explicit phone numbers with country code (for example +12345678901) or WhatsApp JIDs; "default" uses the saved default target. To send a screenshot, first call agentis.browser.screenshot and pass its `ref` (e.g. "artifact:<id>") as an attachment url.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Specific channel connection id. Optional when kind resolves to one active channel.' },
            kind: { type: 'string', enum: [...CHANNEL_KINDS], description: 'Channel kind to use when connectionId is omitted.' },
            to: { type: 'string', description: 'Channel destination. Use "default" or omit for the saved default target. WhatsApp may be a phone number, JID, or saved alias.' },
            body: { type: 'string', description: 'Message body / caption. May be empty when sending attachments only.' },
            attachments: {
              type: 'array',
              description: 'Images or files to deliver. Each item points at one source: an artifact ("artifact:<id>" or artifactId), a data: URL, or an http(s) URL.',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'artifact:<id>, data: URL, or http(s) URL.' },
                  artifactId: { type: 'string', description: 'Artifact id (alternative to url).' },
                  filename: { type: 'string' },
                  mimeType: { type: 'string' },
                  kind: { type: 'string', enum: ['image', 'file'], description: 'Delivery hint; inferred from MIME type when omitted.' },
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
          },
        );
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
    if (obj.kind === 'image' || obj.kind === 'file') ref.kind = obj.kind;
    return ref;
  });
}

function parseKind(value: unknown): ChannelKind | null {
  if (typeof value !== 'string') return null;
  return CHANNEL_KINDS.has(value as ChannelKind) ? value as ChannelKind : null;
}

