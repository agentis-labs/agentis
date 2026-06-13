/**
 * Slack KnowledgeSource — channel + message history crawler (RFC §7.6).
 *
 * Distinct from the Slack workflow connector (which sends messages): this is
 * the continuous-synchronization contract. Default-deny: only channels the
 * owner included sync; with no includedScopes, only PUBLIC channels the bot
 * is a member of. Boundary: private_external / confidential — Slack history
 * is never customer-safe by default.
 *
 * Cursor: JSON map of channelId → newest message ts seen, so each channel
 * resumes independently and out-of-order channels never lose messages.
 */

import type {
  BackfillRequest,
  CanonicalSourceObject,
  DiscoveredSourceScope,
  IncrementalSyncRequest,
  InformationBoundary,
  KnowledgeSource,
  SourceCapabilities,
  SourceChangeBatch,
  SourceConnectionHealth,
  SourcePrincipalInput,
  SourceSyncContext,
} from '../types.js';

const SLACK_BOUNDARY: InformationBoundary = {
  origin: 'private_external',
  confidentiality: 'confidential',
  audience: 'delegated_agents',
  customerSafe: false,
  trainingAllowed: false,
  exportAllowed: false,
  policySource: 'source_acl',
};

const PAGE_LIMIT = 200;
const MAX_MESSAGES_PER_CHANNEL = 1000;

interface SlackChannel { id: string; name: string; is_member?: boolean; is_private?: boolean }
interface SlackMessage { ts: string; user?: string; text?: string; thread_ts?: string; subtype?: string }

export class SlackSource implements KnowledgeSource {
  readonly sourceType = 'slack';
  readonly displayName = 'Slack';
  readonly capabilities: SourceCapabilities = {
    supportsBackfill: true,
    supportsIncrementalCursor: true,
    supportsWebhooks: false,
    supportsDeletes: false,
    supportsAclSync: false,
    supportsIdentityDirectory: true,
    supportsAttachments: false,
    supportsHistory: true,
    consistency: 'eventual',
  };

  async validateConnection(ctx: SourceSyncContext): Promise<SourceConnectionHealth> {
    if (!ctx.accessToken) return { ok: false, detail: 'Slack token missing — connect a credential.' };
    const res = await this.call<{ ok: boolean; error?: string }>(ctx, 'auth.test', {});
    return res.ok ? { ok: true } : { ok: false, detail: res.error ?? 'auth.test failed' };
  }

  async discoverScopes(ctx: SourceSyncContext): Promise<DiscoveredSourceScope[]> {
    const channels = await this.listChannels(ctx);
    return channels.map((channel) => ({
      id: channel.id,
      label: `#${channel.name}`,
      kind: channel.is_private ? 'private_channel' : 'public_channel',
      // Private channels are never recommended by default (RFC §7.2).
      recommended: !channel.is_private && Boolean(channel.is_member),
    }));
  }

  async *backfill(request: BackfillRequest): AsyncIterable<SourceChangeBatch> {
    yield* this.crawl(request, {});
  }

  async *synchronize(request: IncrementalSyncRequest): AsyncIterable<SourceChangeBatch> {
    yield* this.crawl(request, parseCursor(request.cursor));
  }

  async *resolvePrincipals(ctx: SourceSyncContext): AsyncIterable<SourcePrincipalInput> {
    let cursor: string | undefined;
    do {
      const res = await this.call<{ ok: boolean; members?: Array<{ id: string; name: string; deleted?: boolean; is_bot?: boolean; profile?: { real_name?: string; email?: string } }>; response_metadata?: { next_cursor?: string } }>(
        ctx, 'users.list', { limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
      if (!res.ok) break;
      for (const member of res.members ?? []) {
        if (member.deleted) continue;
        yield {
          externalPrincipalId: member.id,
          kind: member.is_bot ? 'service' : 'person',
          displayName: member.profile?.real_name ?? member.name,
          email: member.profile?.email,
        };
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  private async *crawl(ctx: SourceSyncContext, since: Record<string, string>): AsyncIterable<SourceChangeBatch> {
    const channels = (await this.listChannels(ctx))
      .filter((channel) => {
        if (ctx.excludedScopes.includes(channel.id)) return false;
        if (ctx.includedScopes.length > 0) return ctx.includedScopes.includes(channel.id);
        return Boolean(channel.is_member) && !channel.is_private; // default-deny private
      });
    const newest = { ...since };
    for (const channel of channels) {
      if (ctx.signal?.aborted) return;
      const objects: CanonicalSourceObject[] = [];
      let pageCursor: string | undefined;
      let fetched = 0;
      do {
        const res = await this.call<{ ok: boolean; error?: string; messages?: SlackMessage[]; response_metadata?: { next_cursor?: string } }>(
          ctx, 'conversations.history', {
            channel: channel.id,
            limit: String(PAGE_LIMIT),
            ...(since[channel.id] ? { oldest: since[channel.id]!, inclusive: 'false' } : {}),
            ...(pageCursor ? { cursor: pageCursor } : {}),
          });
        if (!res.ok) throw new Error(`Slack conversations.history failed for #${channel.name}: ${res.error}`);
        for (const message of res.messages ?? []) {
          if (message.subtype || !message.text) continue; // joins/bots-noise skipped
          fetched += 1;
          const at = slackTsToIso(message.ts);
          if (!newest[channel.id] || message.ts > newest[channel.id]!) newest[channel.id] = message.ts;
          objects.push({
            externalId: `msg:${channel.id}:${message.ts}`,
            objectType: 'message',
            title: `#${channel.name}`,
            nativeUrl: undefined,
            parentExternalId: message.thread_ts ? `msg:${channel.id}:${message.thread_ts}` : undefined,
            authorExternalId: message.user,
            createdAt: at,
            modifiedAt: at,
            observedAt: new Date().toISOString(),
            content: message.text,
            attributes: { channelId: channel.id, channelName: channel.name },
            boundary: SLACK_BOUNDARY,
          });
        }
        pageCursor = res.response_metadata?.next_cursor || undefined;
      } while (pageCursor && fetched < MAX_MESSAGES_PER_CHANNEL);
      if (objects.length > 0) {
        yield { objects, deletions: [], cursor: JSON.stringify(newest) };
      }
    }
    yield { objects: [], deletions: [], cursor: JSON.stringify(newest), done: true };
  }

  private async listChannels(ctx: SourceSyncContext): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.call<{ ok: boolean; error?: string; channels?: SlackChannel[]; response_metadata?: { next_cursor?: string } }>(
        ctx, 'conversations.list', { limit: String(PAGE_LIMIT), types: 'public_channel,private_channel', ...(cursor ? { cursor } : {}) });
      if (!res.ok) throw new Error(`Slack conversations.list failed: ${res.error}`);
      channels.push(...(res.channels ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return channels;
  }

  private async call<T>(ctx: SourceSyncContext, method: string, params: Record<string, string>): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`https://slack.com/api/${method}${query ? `?${query}` : ''}`, {
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      signal: ctx.signal ?? null,
    });
    if (res.status === 429) {
      throw new Error(`Slack rate limit on ${method}; retry after ${res.headers.get('retry-after') ?? '?'}s`);
    }
    if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
    return await res.json() as T;
  }
}

function parseCursor(cursor: string | null | undefined): Record<string, string> {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(cursor) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
}
