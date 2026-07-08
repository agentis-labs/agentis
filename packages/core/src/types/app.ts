

import { z } from 'zod';

// Local, single-operator lifecycle: an app either exists and is usable (`active`)
// or is retired (`archived`). Publishing ("draft"→"published") is a Hub concept
// and lives there, not in the local runtime. Legacy `draft`/`published` rows are
// coerced to `active` on read (see normalizeAppStatus).
export const appStatusSchema = z.enum(['active', 'archived']);
export type AppStatus = z.infer<typeof appStatusSchema>;

/** Map any stored/legacy status string to the current lifecycle. */
export function normalizeAppStatus(value: unknown): AppStatus {
  return value === 'archived' ? 'archived' : 'active';
}

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
  
  requireApprovalFor: z.array(z.string().min(1)).default([]).optional(),
});
export type AppOutboundPolicy = z.infer<typeof appOutboundPolicySchema>;

export const appPolicySchema = z.object({
  /** CustomView/compiled-code escape hatch. Disabled by default for portable OSS apps. */
  customCode: z.enum(['disabled', 'allowed']).default('disabled'),
  
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


export const appWorkflowBindingSchema = z.object({
  order: z.number().int().min(0).optional(),
  purpose: z.string().max(400).optional(),
  enabled: z.boolean().optional(),
  dependsOn: z.array(z.string()).default([]),
  /**
   * App-level recurring schedule (APP-INTERFACE-10X §2.3) — a standard 5-field
   * cron expression the AppOrchestrator fires through the SAME run queue as every
   * other start (never a forked execution path). Graph-authored triggers stay
   * authoritative where present; this is the App's own layer for "run this at…".
   */
  schedule: z
    .object({
      cron: z.string().min(9).max(120),
      enabled: z.boolean().default(true),
    })
    .nullable()
    .optional(),
  /** `exclusive` = skip an orchestrated start while a run of this workflow is still active. */
  concurrency: z.enum(['parallel', 'exclusive']).optional(),
  /** When dependents fire: after upstream success only (default) or on any settle. */
  chainOn: z.enum(['success', 'always']).optional(),
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
  /** A run currently executing (running/waiting), if any — the live pulse. */
  activeRun: { id: string; status: string; startedAt: string } | null;
  /** App-level schedule rule (binding.schedule). */
  schedule: { cron: string; enabled: boolean } | null;
  /** Next App-level scheduled fire, when computable. */
  nextRunAt: string | null;
  /** Orchestrated-start concurrency policy. */
  concurrency: 'parallel' | 'exclusive';
  /** When dependents of this workflow fire. */
  chainOn: 'success' | 'always';
}



