/**
 * ConnectionGrantService — per-agent scoped authority over connections
 * (Agent-Native Platform Plan §3.3).
 *
 * The audit's finding: `agentis.channel.send` had ZERO owner check — any agent
 * could send on any connection — even though the exact per-agent ACL shape
 * (`mode`/scopes/`expiresAt`) already shipped as `grounding_agent_grants`, bound
 * to the wrong resource. This service is that shape, generalized to any
 * connection (channel / credential / mcp) and enforced at the single send door.
 *
 * Agent-owned connections are isolated by default: only their owner or an
 * explicitly granted agent may use them. A workspace-owned connection with no
 * grant rows remains shared for compatibility; issuing the first grant (or
 * enabling global enforcement) changes it to default-deny.
 *
 * `request` is the capability-negotiation on-ramp: an agent that lacks access
 * writes a `status='requested'` row an operator approves (→ `grant`).
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export type ConnectionScope = 'read' | 'send' | 'manage';
export type ConnectionKind = 'channel' | 'credential' | 'mcp';
export type GrantStatus = 'active' | 'requested' | 'revoked';

const SCOPE_RANK: Record<ConnectionScope, number> = { read: 1, send: 2, manage: 3 };

export interface GrantInput {
  workspaceId: string;
  connectionKind: ConnectionKind;
  connectionId: string;
  agentId: string;
  scope?: ConnectionScope;
  status?: GrantStatus;
  note?: string | null;
  grantedBy?: string | null;
  expiresAt?: string | null;
}

export interface AuthorizeInput {
  workspaceId: string;
  connectionId: string;
  agentId: string;
  /** Scope the action needs. Defaults to `send`. */
  required?: ConnectionScope;
  /** When known, the connection's owner agent — always implicitly authorized. */
  ownerAgentId?: string | null;
}

export interface AuthorizeDecision {
  ok: boolean;
  reason?: string;
}

export class ConnectionGrantService {
  constructor(
    private readonly db: AgentisSqliteDb,
    /** Global hard-enforce switch. Off by default → ungoverned connections stay open. */
    private readonly enforceAll = false,
  ) {}

  /** Issue (or re-activate) an active grant. Idempotent on (workspace, connection, agent). */
  grant(input: GrantInput) {
    return this.#upsert({ ...input, status: input.status ?? 'active' });
  }

  /** An agent asks for access it lacks — creates/updates a `requested` row for the operator. */
  request(input: Omit<GrantInput, 'status' | 'grantedBy'> & { grantedBy?: string | null }) {
    return this.#upsert({ ...input, status: 'requested', scope: input.scope ?? 'send' });
  }

  /** Revoke by grant id (soft: status → revoked so the audit trail survives). */
  revoke(workspaceId: string, id: string): void {
    this.db.update(schema.connectionAgentGrants)
      .set({ status: 'revoked', updatedAt: new Date().toISOString() })
      .where(and(eq(schema.connectionAgentGrants.workspaceId, workspaceId), eq(schema.connectionAgentGrants.id, id)))
      .run();
  }

  /** All grants governing a connection. */
  list(workspaceId: string, connectionId: string) {
    return this.db.select().from(schema.connectionAgentGrants)
      .where(and(
        eq(schema.connectionAgentGrants.workspaceId, workspaceId),
        eq(schema.connectionAgentGrants.connectionId, connectionId),
      )).all();
  }

  /** All grants held by an agent (for its self-inventory / orient). */
  listForAgent(workspaceId: string, agentId: string) {
    return this.db.select().from(schema.connectionAgentGrants)
      .where(and(
        eq(schema.connectionAgentGrants.workspaceId, workspaceId),
        eq(schema.connectionAgentGrants.agentId, agentId),
      )).all();
  }

  /** Pending requests awaiting operator approval. */
  listRequests(workspaceId: string) {
    return this.db.select().from(schema.connectionAgentGrants)
      .where(and(
        eq(schema.connectionAgentGrants.workspaceId, workspaceId),
        eq(schema.connectionAgentGrants.status, 'requested'),
      )).all();
  }

  /**
   * The authorization decision at the use door. Order:
   *  1. The connection's owner agent is always allowed.
   *  2. An active, non-expired grant at ≥ required scope allows.
   *  3. A different agent's owned connection is denied unless it has an active grant.
   *  4. Workspace-owned connection with no grants + not globally enforced → allow.
   *  5. Otherwise deny.
   */
  authorize(input: AuthorizeInput): AuthorizeDecision {
    const required = input.required ?? 'send';
    const owner = input.ownerAgentId ?? this.#resolveChannelOwner(input.workspaceId, input.connectionId);
    if (owner && owner === input.agentId) return { ok: true };

    const grants = this.list(input.workspaceId, input.connectionId);
    const now = Date.now();
    const active = grants.filter((g) => g.status === 'active' && !this.#expired(g.expiresAt, now));

    const mine = active.find((g) => g.agentId === input.agentId
      && SCOPE_RANK[(g.scope as ConnectionScope)] >= SCOPE_RANK[required]);
    if (mine) return { ok: true };

    // Ownership is an isolation boundary, not a UI preference. An agent cannot
    // inherit another agent's phone/token merely because that connection has no
    // grant rows yet. Explicit grants above are the only cross-owner route.
    if (owner) {
      return {
        ok: false,
        reason: `agent ${input.agentId} lacks a '${required}' grant on connection ${input.connectionId}`,
      };
    }

    // Workspace-owned connections are deliberately shared until governed.
    if (grants.length === 0 && !this.enforceAll) return { ok: true };

    return {
      ok: false,
      reason: `agent ${input.agentId} lacks a '${required}' grant on connection ${input.connectionId}`,
    };
  }

  #upsert(input: GrantInput) {
    const now = new Date().toISOString();
    const existing = this.db.select().from(schema.connectionAgentGrants)
      .where(and(
        eq(schema.connectionAgentGrants.workspaceId, input.workspaceId),
        eq(schema.connectionAgentGrants.connectionId, input.connectionId),
        eq(schema.connectionAgentGrants.agentId, input.agentId),
      )).get();
    if (existing) {
      this.db.update(schema.connectionAgentGrants).set({
        connectionKind: input.connectionKind,
        scope: input.scope ?? existing.scope,
        status: input.status ?? existing.status,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.grantedBy !== undefined ? { grantedBy: input.grantedBy } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        updatedAt: now,
      }).where(eq(schema.connectionAgentGrants.id, existing.id)).run();
      return { ...existing, ...input, id: existing.id, updatedAt: now };
    }
    const id = randomUUID();
    const row = {
      id,
      workspaceId: input.workspaceId,
      connectionKind: input.connectionKind,
      connectionId: input.connectionId,
      agentId: input.agentId,
      scope: input.scope ?? 'send',
      status: input.status ?? 'active',
      note: input.note ?? null,
      grantedBy: input.grantedBy ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.connectionAgentGrants).values(row).run();
    return row;
  }

  #resolveChannelOwner(workspaceId: string, connectionId: string): string | null {
    const row = this.db.select({ agentId: schema.channelConnections.agentId })
      .from(schema.channelConnections)
      .where(and(
        eq(schema.channelConnections.workspaceId, workspaceId),
        eq(schema.channelConnections.id, connectionId),
      )).get();
    return row?.agentId ?? null;
  }

  #expired(expiresAt: string | null | undefined, now: number): boolean {
    if (!expiresAt) return false;
    const t = Date.parse(expiresAt);
    return Number.isFinite(t) && t <= now;
  }
}
