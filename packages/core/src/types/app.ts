/**
 * Agentic App — the first-class deployable unit (AGENTIC-APPS-10X-MASTERPLAN §1, §3).
 *
 * An App = `{ identity, surfaces, logic, data, agents, memory, policy }` where an
 * agent is the operator and a human is the end-user. This module defines the
 * *identity* + *policy* core; surfaces (§4) and datastore (§5) land in later phases
 * and reference `appId`.
 *
 * An App owns workflows (via `workflows.app_id`). A bare workflow with
 * `app_id = NULL` remains valid — it is simply an App-of-one rendered by the
 * legacy surface. Nothing existing breaks.
 */

import { z } from 'zod';

export const appStatusSchema = z.enum(['draft', 'published', 'archived']);
export type AppStatus = z.infer<typeof appStatusSchema>;

export const appMemberRoleSchema = z.enum(['operator', 'worker']);
export type AppMemberRole = z.infer<typeof appMemberRoleSchema>;

export const appSourceSchema = z.object({
  kind: z.enum(['local', 'hub']),
  id: z.string().min(1),
  remoteId: z.string().min(1).optional(),
  author: z.record(z.unknown()).optional(),
});
export type AppSource = z.infer<typeof appSourceSchema>;

/** Slug shape shared with packages: lowercase, dash-separated, no leading/trailing dash. */
const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, 'slug must be lowercase alphanumeric with dashes');

/**
 * Identity/contract block of an App — the public-facing descriptor stored in
 * `apps.manifest_json`. This is the *identity* sub-part of the full portable
 * `AppManifest` IR (see `manifest.ts`, AGENTIC-SYSTEMS-ARCHITECTURE §2.1).
 */
export const appIdentitySchema = z.object({
  manifestVersion: z.literal(1).default(1),
  slug: slugSchema,
  name: z.string().min(1).max(160),
  version: z.string().min(1).max(64).default('0.1.0'),
  icon: z.string().nullable().optional(),
  /** Surface the runtime opens first. */
  entrySurfaceId: z.string().nullable().optional(),
  /** Structured, semantic capability descriptors (discovery). */
  capabilities: z.array(z.string()).default([]),
  /** Plugin/integration slugs the App needs the installing workspace to provide. */
  requiredPlugins: z.array(z.string()).default([]),
});
export type AppIdentity = z.infer<typeof appIdentitySchema>;

/**
 * App policy — audience + auth + who-can-see/do-what. Enforced by the action
 * resolver (§4.4) and the custom-code bridge (§4.6). Intentionally permissive in
 * V1; the shape is stable so enforcement can tighten without a migration.
 */
/**
 * Outbound safety envelope (LIVING-APPS-10X §7 · G7). Gates an App's
 * *unsupervised* 24/7 outbound so a resident agent can't over-message a contact,
 * message in the dead of night, or promise something it must not. ALL fields are
 * optional and additive: an absent `outbound` block (or an absent field) means
 * today's unrestricted behavior. Enforced by `OutboundPolicyService.evaluate`.
 */
export const appOutboundPolicySchema = z.object({
  /** Cap on agent-initiated outbound messages per App per rolling hour. Absent = no cap. */
  maxPerHour: z.number().int().positive().optional(),
  /**
   * No unsupervised outbound during these local hours (24h clock). When
   * `start <= end` the window is `[start, end)`; when `start > end` it wraps past
   * midnight (e.g. `{start:22,end:7}` = 22:00–07:00). Inclusive of `start`,
   * exclusive of `end`.
   */
  quietHours: z
    .object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) })
    .optional(),
  /** Substrings/patterns that must NEVER appear in outbound — a match denies the send outright. */
  blockedClaims: z.array(z.string().min(1)).default([]).optional(),
  /** Substrings/patterns that require operator approval before the send goes out. */
  requireApprovalFor: z.array(z.string().min(1)).default([]).optional(),
});
export type AppOutboundPolicy = z.infer<typeof appOutboundPolicySchema>;

export const appPolicySchema = z.object({
  /** Who may open the App's surfaces. Empty = workspace members only. */
  audience: z.array(z.enum(['operator', 'executive', 'customer', 'public'])).default([]),
  /** Public-share toggle for the entry surface. */
  shareable: z.boolean().default(false),
  /** CustomView/compiled-code escape hatch. Disabled by default for portable OSS apps. */
  customCode: z.enum(['disabled', 'allowed']).default('disabled'),
  /** Explicit cross-app/plugin grants. V1 is operator-owned, so enforcement can tighten over this stable shape. */
  grants: z.array(z.object({
    capability: z.string().min(1),
    source: z.enum(['native', 'app', 'plugin']).optional(),
    scopes: z.array(z.string()).default([]),
  })).default([]),
  /** Outbound safety envelope (G7) — rate/quiet-hours/claim limits on unsupervised sends. Absent = unrestricted. */
  outbound: appOutboundPolicySchema.optional(),
});
export type AppPolicy = z.infer<typeof appPolicySchema>;

export interface AppRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  status: AppStatus;
  entrySurfaceId: string | null;
  icon: string | null;
  /** Domain (or Subdomain) this App is organized under. Its workflows inherit. */
  domainId: string | null;
  /** Specialist agent that owns this App; its workflows inherit at dispatch. */
  ownerAgentId: string | null;
  manifest: AppIdentity;
  policy: AppPolicy;
  source: AppSource | null;
  installedChecksum: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppMember {
  appId: string;
  agentId: string;
  role: AppMemberRole;
}

/** Create payload (route + AppStore). */
export const createAppSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).default(''),
  icon: z.string().nullable().optional(),
  /** Domain (or Subdomain) to organize this App under. */
  domainId: z.string().nullable().optional(),
  /** Specialist agent that owns this App. */
  ownerAgentId: z.string().nullable().optional(),
  /** Adopt an existing workflow as the App's entry logic. */
  entryWorkflowId: z.string().optional(),
});
export type CreateAppInput = z.infer<typeof createAppSchema>;

/** Update payload — all fields optional, identity slug immutable post-create. */
export const updateAppSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().nullable().optional(),
  status: appStatusSchema.optional(),
  version: z.string().min(1).max(64).optional(),
  entrySurfaceId: z.string().nullable().optional(),
  domainId: z.string().nullable().optional(),
  ownerAgentId: z.string().nullable().optional(),
  manifest: appIdentitySchema.partial().optional(),
  policy: appPolicySchema.partial().optional(),
  source: appSourceSchema.nullable().optional(),
  installedChecksum: z.string().nullable().optional(),
});
export type UpdateAppInput = z.infer<typeof updateAppSchema>;

/**
 * An App's orchestration metadata for ONE of its workflows — the control plane.
 * Stored on the workflow's own `settings.appBinding` (no migration; a workflow
 * belongs to exactly one App via `workflows.appId`). It answers, per workflow:
 * why it exists (`purpose`), the operator-facing order, whether it's enabled,
 * and which sibling workflows must run first (`dependsOn`). Without this an App
 * is just a bag of workflows with no run/order/explain control.
 */
export const appWorkflowBindingSchema = z.object({
  order: z.number().int().min(0).optional(),
  purpose: z.string().max(400).optional(),
  enabled: z.boolean().optional(),
  dependsOn: z.array(z.string()).default([]),
});
export type AppWorkflowBinding = z.infer<typeof appWorkflowBindingSchema>;

/** PATCH payload for an App→workflow binding. */
export const updateAppWorkflowBindingSchema = appWorkflowBindingSchema.partial();
export type UpdateAppWorkflowBindingInput = z.infer<typeof updateAppWorkflowBindingSchema>;

/** A workflow as seen from its owning App's control plane. */
export interface AppWorkflowSummary {
  id: string;
  title: string;
  /** Why this workflow exists in the App (binding.purpose, else the description). */
  purpose: string | null;
  order: number;
  enabled: boolean;
  dependsOn: string[];
  /** Derived from the trigger node: manual | cron | webhook | persistent_listener | … */
  triggerKind: string | null;
  /** Most recent run, if any. */
  lastRun: { id: string; status: string; at: string } | null;
}
