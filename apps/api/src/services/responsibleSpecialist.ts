/**
 * Responsible-specialist resolution — the runtime half of manager-owned org
 * structure (Domains → Subdomains → specialists).
 *
 * Deterministic precedence for "who owns this work":
 *   1. workflow.ownerAgentId        — a workflow pinned to a specialist
 *   2. subdomain/domain.managerId   — the specialist/manager running the domain
 *                                     the workflow belongs to (workflow.domain_id)
 *   3. app.ownerAgentId             — the specialist who owns the App that owns
 *                                     the workflow (App-level inheritance)
 *   4. app subdomain/domain.managerId — the manager of the App's domain
 *   5. domain.managerId             — the manager of the top-level domain
 *
 * `via` lets callers distinguish genuine specialist responsibility ('owner' /
 * 'app' / 'subdomain') from the manager fallback ('domain') so dispatch can
 * choose to apply only the former (the manager delegates rather than executes).
 */
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export type ResponsibilityVia = 'owner' | 'app' | 'subdomain' | 'domain';

export interface ResolveResponsibleInput {
  workflowId?: string | null;
  /** A subdomain (or domain) id the work belongs to. */
  subdomainId?: string | null;
  /** A top-level domain id (manager fallback). */
  domainId?: string | null;
}

export interface ResponsibleSpecialist {
  agentId: string;
  via: ResponsibilityVia;
}

export function resolveResponsibleSpecialist(
  db: AgentisSqliteDb,
  workspaceId: string,
  input: ResolveResponsibleInput,
): ResponsibleSpecialist | null {
  let subdomainId = input.subdomainId ?? null;

  // 1. Direct per-workflow ownership wins. A workflow's domain (spaceId) may be
  //    a subdomain — fold it into the subdomain lookup below.
  if (input.workflowId) {
    const wf = db
      .select({
        ownerAgentId: schema.workflows.ownerAgentId,
        spaceId: schema.workflows.spaceId,
        appId: schema.workflows.appId,
      })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, input.workflowId), eq(schema.workflows.workspaceId, workspaceId)))
      .get();
    if (wf?.ownerAgentId) return { agentId: wf.ownerAgentId, via: 'owner' };
    if (!subdomainId && wf?.spaceId) subdomainId = wf.spaceId;

    // 1b. App-level inheritance: a workflow with no own owner/domain inherits
    //     from the App that owns it. The App's owner is genuine specialist
    //     responsibility ('app'); its domain folds into the subdomain lookup.
    if (!wf?.ownerAgentId && !subdomainId && wf?.appId) {
      const appRow = db
        .select({ ownerAgentId: schema.apps.ownerAgentId, spaceId: schema.apps.spaceId })
        .from(schema.apps)
        .where(and(eq(schema.apps.id, wf.appId), eq(schema.apps.workspaceId, workspaceId)))
        .get();
      if (appRow?.ownerAgentId) return { agentId: appRow.ownerAgentId, via: 'app' };
      if (appRow?.spaceId) subdomainId = appRow.spaceId;
    }
  }

  // 2. The specialist running the subdomain (a domain row WITH a parent).
  if (subdomainId) {
    const domain = db
      .select({ managerId: schema.domains.managerId, parentDomainId: schema.domains.parentDomainId })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, subdomainId), eq(schema.domains.workspaceId, workspaceId)))
      .get();
    if (domain?.managerId) {
      return { agentId: domain.managerId, via: domain.parentDomainId ? 'subdomain' : 'domain' };
    }
  }

  // 3. Top-level domain manager fallback.
  if (input.domainId) {
    const domain = db
      .select({ managerId: schema.domains.managerId })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.workspaceId, workspaceId)))
      .get();
    if (domain?.managerId) return { agentId: domain.managerId, via: 'domain' };
  }

  return null;
}
