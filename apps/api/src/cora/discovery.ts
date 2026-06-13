/**
 * CORA Onboarding — read-only discovery + the three-moment quickstart
 * compiler (RFC §14.7–§14.10).
 *
 * Discovery inspects only what Agentis can already see: agents, workflows,
 * credentials, and channel connections. It never reads private SaaS content
 * before authorization — sources it merely recognizes are labelled
 * 'connect'/'suggested_later', never 'ready' (RFC §14.8).
 *
 * `launch` is idempotent (RFC §14.13): repeated clicks reuse the existing
 * profile, connection, and learning plan instead of duplicating them.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { CoraSourceFabric } from './sourceFabric.js';
import type { CoraContextComposer } from './contextComposer.js';
import type { AgentGrantMode, CoraDiscoveryResult, CoraSourceCandidate, LearningPlanStage } from './types.js';

/** Credential-type → suggested source mapping (recognition, not authorization). */
const CREDENTIAL_SOURCE_HINTS: Record<string, { sourceType: string; displayName: string }> = {
  slack: { sourceType: 'slack', displayName: 'Slack' },
  google: { sourceType: 'google_drive', displayName: 'Google Drive' },
  github: { sourceType: 'github', displayName: 'GitHub' },
  notion: { sourceType: 'notion', displayName: 'Notion' },
};

const DEFAULT_STAGES: LearningPlanStage[] = [
  { kind: 'sync', mode: 'deterministic', status: 'pending' },
  { kind: 'normalize', mode: 'deterministic', status: 'pending' },
  { kind: 'secure', mode: 'deterministic', status: 'pending' },
  { kind: 'extract', mode: 'deterministic', status: 'pending' },
  { kind: 'reason', mode: 'selective_model', status: 'pending' },
  { kind: 'review', mode: 'owner_gate', status: 'pending' },
  { kind: 'publish', mode: 'deterministic', status: 'pending' },
];

export interface DiscoveryDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  fabric: CoraSourceFabric;
  composer: CoraContextComposer;
}

export class CoraDiscoveryService {
  constructor(private readonly deps: DiscoveryDeps) {}

  private get db() { return this.deps.db; }

  /** Moment 2: "We found your operating surface." Read-only, fast, streamable. */
  discover(workspaceId: string): CoraDiscoveryResult {
    const workspace = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
    const agents = this.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all();
    const workflows = this.db.select({ id: schema.workflows.id, title: schema.workflows.title })
      .from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all();
    const creds = this.db.select({ id: schema.credentials.id, name: schema.credentials.name, credentialType: schema.credentials.credentialType })
      .from(schema.credentials).where(eq(schema.credentials.workspaceId, workspaceId)).all();
    const channels = this.db.select({ kind: schema.channelConnections.kind })
      .from(schema.channelConnections).where(eq(schema.channelConnections.workspaceId, workspaceId)).all();
    const existingConnections = this.deps.fabric.listConnections(workspaceId);
    const connectedTypes = new Set(existingConnections.map((c) => c.sourceType));

    const detectedSources: CoraSourceCandidate[] = [];

    // Agentis-native is always ready — first-party evidence, zero credentials.
    detectedSources.push({
      sourceType: 'agentis_native',
      displayName: 'Agentis',
      connectionId: existingConnections.find((c) => c.sourceType === 'agentis_native')?.id,
      state: 'ready',
      reason: `${agents.length} agent(s), ${workflows.length} workflow(s), and run history are first-party evidence.`,
      proposedBrief: {
        purpose: 'operations',
        knowledgeObjectives: ['Actual agent behavior', 'Workflow outcomes', 'Operating improvements'],
      },
      requiresOwnerAction: false,
    });

    // Recognize likely sources from stored credentials — Suggested, never Connected.
    const seen = new Set<string>(['agentis_native']);
    for (const cred of creds) {
      const key = Object.keys(CREDENTIAL_SOURCE_HINTS).find((k) =>
        cred.credentialType.toLowerCase().includes(k) || cred.name.toLowerCase().includes(k));
      if (!key) continue;
      const hint = CREDENTIAL_SOURCE_HINTS[key]!;
      if (seen.has(hint.sourceType)) continue;
      seen.add(hint.sourceType);
      const registered = this.deps.fabric.getSource(hint.sourceType) !== null;
      detectedSources.push({
        sourceType: hint.sourceType,
        displayName: hint.displayName,
        connectionId: existingConnections.find((c) => c.sourceType === hint.sourceType)?.id,
        state: connectedTypes.has(hint.sourceType) ? 'ready' : registered ? 'connect' : 'suggested_later',
        reason: `Credential "${cred.name}" suggests ${hint.displayName} is part of this operation.`,
        proposedBrief: { purpose: 'operations', knowledgeObjectives: [] },
        requiresOwnerAction: !connectedTypes.has(hint.sourceType),
      });
    }
    for (const channel of channels) {
      if (seen.has(channel.kind)) continue;
      seen.add(channel.kind);
      detectedSources.push({
        sourceType: channel.kind,
        displayName: channel.kind,
        state: 'suggested_later',
        reason: `A live ${channel.kind} channel exists; historical ingestion needs separate consent.`,
        proposedBrief: { purpose: 'customers', knowledgeObjectives: [] },
        requiresOwnerAction: true,
      });
    }

    // Grant recommendations from real roles (RFC §14.9).
    const suggestedAgentGrants = agents.map((agent) => {
      const role = (agent.role ?? '').toLowerCase();
      const mode: AgentGrantMode = role === 'orchestrator' ? 'full_delegated' : 'agent_decides';
      return {
        agentId: agent.id,
        agentName: agent.name,
        mode,
        reason: role === 'orchestrator'
          ? 'Orchestrators coordinate everything; broad retrieval within owner grants.'
          : 'Specialists retrieve on demand within the configured ceiling.',
      };
    });

    const result: CoraDiscoveryResult = {
      workspaceId,
      inferredName: workspace?.name,
      inferredCharter: this.inferCharter(workspace?.name, agents.length, workflows.map((w) => w.title)),
      detectedSources,
      suggestedDomains: this.inferDomains(agents.map((a) => a.spaceTag ?? '').filter(Boolean), workflows.map((w) => w.title)),
      suggestedAgentGrants,
      warnings: [],
      discoveredAt: new Date().toISOString(),
    };
    this.persistProfileDraft(workspaceId, result);
    return result;
  }

  /** Moment 3 + launch: compile choices into profile + connections + grants + plan. Idempotent. */
  launch(args: {
    workspaceId: string;
    ownerUserId?: string | null;
    name?: string;
    intent?: string;
    operatingShape?: string;
    charter?: string;
    acceptSources?: string[];
    acceptGrants?: Array<{ agentId: string; mode: AgentGrantMode }>;
  }): { profileId: string; learningPlanId: string; connectionIds: string[] } {
    const now = new Date().toISOString();
    // 1. Owner profile (one per workspace).
    let profile = this.db.select().from(schema.coraOwnerProfiles)
      .where(eq(schema.coraOwnerProfiles.workspaceId, args.workspaceId)).get();
    if (!profile) {
      const id = randomUUID();
      this.db.insert(schema.coraOwnerProfiles).values({
        id,
        workspaceId: args.workspaceId,
        ownerUserId: args.ownerUserId ?? null,
        name: args.name ?? null,
        intent: args.intent ?? null,
        operatingShape: args.operatingShape ?? 'personal_project',
        charter: args.charter ?? null,
        onboardingState: 'launched',
      }).run();
      profile = this.db.select().from(schema.coraOwnerProfiles).where(eq(schema.coraOwnerProfiles.id, id)).get()!;
    } else {
      this.db.update(schema.coraOwnerProfiles)
        .set({
          name: args.name ?? profile.name,
          intent: args.intent ?? profile.intent,
          operatingShape: args.operatingShape ?? profile.operatingShape,
          charter: args.charter ?? profile.charter,
          onboardingState: 'launched',
          updatedAt: now,
        })
        .where(eq(schema.coraOwnerProfiles.id, profile.id))
        .run();
    }

    // 2. Connections for accepted ready sources (default: agentis_native).
    const accepted = args.acceptSources ?? ['agentis_native'];
    const existing = this.deps.fabric.listConnections(args.workspaceId);
    const connectionIds: string[] = [];
    for (const sourceType of accepted) {
      const already = existing.find((c) => c.sourceType === sourceType);
      if (already) {
        connectionIds.push(already.id);
        continue;
      }
      if (!this.deps.fabric.getSource(sourceType)) continue; // unregistered → stays a suggestion
      const created = this.deps.fabric.createConnection({ workspaceId: args.workspaceId, sourceType });
      connectionIds.push(created.id);
    }

    // 3. Agent grants from accepted recommendations.
    for (const grant of args.acceptGrants ?? []) {
      this.deps.composer.putGrant({ workspaceId: args.workspaceId, agentId: grant.agentId, mode: grant.mode });
    }

    // 4. Learning plan (one per workspace).
    let plan = this.db.select().from(schema.coraLearningPlans)
      .where(eq(schema.coraLearningPlans.workspaceId, args.workspaceId)).get();
    if (!plan) {
      const id = randomUUID();
      this.db.insert(schema.coraLearningPlans).values({
        id,
        workspaceId: args.workspaceId,
        ownerUserId: args.ownerUserId ?? null,
        sourceConnectionIdsJson: connectionIds,
        stagesJson: DEFAULT_STAGES,
        reasoningMode: 'adaptive',
      }).run();
      plan = this.db.select().from(schema.coraLearningPlans).where(eq(schema.coraLearningPlans.id, id)).get()!;
    } else {
      const merged = [...new Set([...(plan.sourceConnectionIdsJson as string[] ?? []), ...connectionIds])];
      this.db.update(schema.coraLearningPlans)
        .set({ sourceConnectionIdsJson: merged, updatedAt: now })
        .where(eq(schema.coraLearningPlans.id, plan.id))
        .run();
    }
    this.deps.logger.info('cora.onboarding.launched', { workspaceId: args.workspaceId, connections: connectionIds.length });
    return { profileId: profile.id, learningPlanId: plan.id, connectionIds };
  }

  getProfile(workspaceId: string) {
    return this.db.select().from(schema.coraOwnerProfiles)
      .where(eq(schema.coraOwnerProfiles.workspaceId, workspaceId)).get() ?? null;
  }

  getLearningPlan(workspaceId: string) {
    return this.db.select().from(schema.coraLearningPlans)
      .where(eq(schema.coraLearningPlans.workspaceId, workspaceId)).get() ?? null;
  }

  updateLearningPlanStage(workspaceId: string, kind: string, status: string) {
    const plan = this.getLearningPlan(workspaceId);
    if (!plan) return null;
    const stages = (plan.stagesJson as LearningPlanStage[]).map((s) =>
      s.kind === kind ? { ...s, status: status as LearningPlanStage['status'] } : s);
    this.db.update(schema.coraLearningPlans)
      .set({ stagesJson: stages, updatedAt: new Date().toISOString() })
      .where(eq(schema.coraLearningPlans.id, plan.id))
      .run();
    return this.getLearningPlan(workspaceId);
  }

  private persistProfileDraft(workspaceId: string, result: CoraDiscoveryResult): void {
    const profile = this.getProfile(workspaceId);
    if (profile && profile.onboardingState !== 'pending') return;
    if (!profile) {
      this.db.insert(schema.coraOwnerProfiles).values({
        id: randomUUID(),
        workspaceId,
        name: result.inferredName ?? null,
        charter: result.inferredCharter ?? null,
        onboardingState: 'discovered',
        defaultsJson: { suggestedDomains: result.suggestedDomains },
      }).run();
    } else {
      this.db.update(schema.coraOwnerProfiles)
        .set({ onboardingState: 'discovered', updatedAt: new Date().toISOString() })
        .where(eq(schema.coraOwnerProfiles.id, profile.id))
        .run();
    }
  }

  private inferCharter(name: string | undefined, agentCount: number, workflowTitles: string[]): string {
    const focus = workflowTitles.slice(0, 3).join(', ');
    return [
      `${name ?? 'This workspace'} runs ${agentCount} agent(s)`,
      focus ? `working on: ${focus}` : 'with no workflows yet',
      '— the Brain will learn how this operation actually works from its own activity first.',
    ].join(' ');
  }

  private inferDomains(spaceTags: string[], workflowTitles: string[]): string[] {
    const domains = new Set<string>(spaceTags.map((t) => t.toLowerCase()));
    const text = workflowTitles.join(' ').toLowerCase();
    for (const [needle, domain] of [
      ['customer', 'Customers'], ['support', 'Customers'], ['market', 'Marketing'],
      ['email', 'Communications'], ['deploy', 'Engineering'], ['report', 'Operations'],
    ] as const) {
      if (text.includes(needle)) domains.add(domain);
    }
    if (domains.size === 0) domains.add('Operations');
    return [...domains].slice(0, 6);
  }
}
