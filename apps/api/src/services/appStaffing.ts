/**
 * AppStaffingService — birth-staff-at-creation (LIVING-APPS-10X §4.6, Phase R).
 *
 * Today an App is born unowned and empty of people: `AppStore.create` sets
 * `ownerAgentId: null` and inserts zero `app_members`, even though the whole
 * machinery to make and seat specialists already exists. This service closes
 * that gap — when an App is created it assembles its **cast**:
 *
 *   1. Derive the cast from the App's intent (deriveCast) — a single operator for
 *      a bare automation, a fuller team (greeter/qualifier/closer …) for a
 *      relationship-shaped App.
 *   2. For each role, **reuse** a fitting workspace specialist if one exists
 *      (specialists stay normal, reusable agents — the talent pool), otherwise
 *      **materialize** a new one (SpecialistAgentService.authorSpecialist), born
 *      with competence (instructions + capability tags), not an empty shell.
 *   3. **Pin** any default abilities for the role (SpecialistLoadoutService) —
 *      best-effort; competence is carried by the specialist definition when no
 *      ability rows exist yet.
 *   4. **Seat** each agent in `app_members` (one operator, the rest workers) and
 *      set `apps.ownerAgentId` to the operator.
 *
 * Idempotent (an App that already has members is left untouched) and
 * non-throwing at the boundary (staffing never fails app creation — an
 * unstaffed App is degraded, not broken).
 */

import type { AppStore } from '@agentis/app';
import type { AppMemberRole } from '@agentis/core';
import type { SpecialistAgentService } from './specialistAgents.js';
import type { Logger } from '../logger.js';

/** A role in an App's cast — a specialist seat with baked-in operating competence. */
export interface CastRole {
  /** Stable functional role slug (snake_case), e.g. `sales_qualifier`. */
  role: string;
  /** Display title, e.g. "Qualifier". */
  title: string;
  /** This seat owns the App (the operator). Exactly one per cast. */
  operator?: boolean;
  /** The specialist's operating doctrine — its competence, baked into identity. */
  instructions: string;
  /** Routing/competence tags. */
  capabilityTags: string[];
  /** Ability slugs to pin for this role (best-effort; skipped when absent). */
  abilities?: string[];
  avatarGlyph?: string;
  colorHex?: string;
}

export type AppArchetype = 'sales' | 'support' | 'analytics' | 'research' | 'automation';

export interface StaffAppInput {
  workspaceId: string;
  userId: string;
  appId: string;
  name: string;
  description?: string;
  /** Override the derived cast (e.g. an agent specifying its own team). */
  cast?: CastRole[];
}

export interface StaffedMember {
  agentId: string;
  functionalRole: string;
  memberRole: AppMemberRole;
  created: boolean;
}

export interface StaffResult {
  ownerAgentId: string | null;
  members: StaffedMember[];
  archetype: AppArchetype;
  /** Set when the App already had members and staffing was a no-op. */
  skipped?: 'already_staffed';
}

export interface AppStaffingDeps {
  store: AppStore;
  specialists: SpecialistAgentService;
  logger?: Logger;
}

export class AppStaffingService {
  constructor(private readonly deps: AppStaffingDeps) {}

  /**
   * Staff an App with its cast. Idempotent and non-throwing — returns the staffed
   * members, or `skipped: 'already_staffed'` when the App already has people.
   */
  async staffApp(input: StaffAppInput): Promise<StaffResult> {
    const archetype = classifyAppArchetype(input.name, input.description ?? '');
    try {
      const existing = this.deps.store.listMembers(input.workspaceId, input.appId);
      if (existing.length > 0) {
        const owner = this.deps.store.get(input.workspaceId, input.appId).ownerAgentId ?? null;
        return { ownerAgentId: owner, members: [], archetype, skipped: 'already_staffed' };
      }

      const cast = input.cast ?? deriveCast(archetype);
      const members: StaffedMember[] = [];
      let ownerAgentId: string | null = null;

      for (const role of cast) {
        const seated = await this.#seatRole(input, role);
        if (!seated) continue;
        members.push(seated);
        if (role.operator) ownerAgentId = seated.agentId;
      }

      // Never leave an App unowned: fall back to the first seated member.
      if (!ownerAgentId && members[0]) ownerAgentId = members[0].agentId;
      if (ownerAgentId) {
        this.deps.store.update(input.workspaceId, input.appId, { ownerAgentId });
      }

      return { ownerAgentId, members, archetype };
    } catch (err) {
      this.deps.logger?.warn?.('app.staffing.failed', {
        appId: input.appId,
        err: (err as Error).message,
      });
      return { ownerAgentId: null, members: [], archetype };
    }
  }

  /** Reuse-or-materialize one role, pin its abilities, and seat it. */
  async #seatRole(input: StaffAppInput, role: CastRole): Promise<StaffedMember | null> {
    const memberRole: AppMemberRole = role.operator ? 'operator' : 'worker';
    try {
      // Reuse a fitting workspace specialist (talent pool) before creating one.
      const reused = this.deps.specialists.resolveRole(input.workspaceId, role.role);
      let agentId: string;
      let created: boolean;
      if (reused) {
        agentId = reused;
        created = false;
      } else {
        const authored = await this.deps.specialists.authorSpecialist(input.workspaceId, input.userId, {
          role: role.role,
          name: role.title,
          instructions: role.instructions,
          capabilityTags: role.capabilityTags,
          ...(role.avatarGlyph ? { avatarGlyph: role.avatarGlyph } : {}),
          ...(role.colorHex ? { colorHex: role.colorHex } : {}),
          source: 'generated',
        });
        agentId = authored.agentId;
        created = authored.created;
      }

      this.deps.store.addMember(input.workspaceId, input.appId, agentId, memberRole);
      return { agentId, functionalRole: role.role, memberRole, created };
    } catch (err) {
      this.deps.logger?.warn?.('app.staffing.seat_failed', {
        appId: input.appId,
        role: role.role,
        err: (err as Error).message,
      });
      return null;
    }
  }

}

// ── Cast derivation ─────────────────────────────────────────────

const KEYWORDS: Array<{ archetype: AppArchetype; re: RegExp }> = [
  { archetype: 'sales', re: /\b(sale|sales|sell|selling|lead|leads|deal|deals|crm|outreach|prospect|pipeline|quote|quotes)\b/i },
  { archetype: 'support', re: /\b(support|help ?desk|ticket|tickets|customer service|service desk|assist|complaint|onboarding)\b/i },
  { archetype: 'analytics', re: /\b(analytic|analytics|dashboard|metric|metrics|report|reporting|kpi|insight|insights|forecast)\b/i },
  { archetype: 'research', re: /\b(research|monitor|monitoring|watch|watcher|track|tracking|scan|scanner|digest|intelligence|feed)\b/i },
];

/** Classify an App into an archetype from its name + description (deterministic). */
export function classifyAppArchetype(name: string, description: string): AppArchetype {
  const hay = `${name} ${description}`;
  for (const { archetype, re } of KEYWORDS) {
    if (re.test(hay)) return archetype;
  }
  return 'automation';
}

/**
 * The default cast for an archetype. A relationship-shaped App is born with a
 * real team; a bare automation gets a single operator so it is never unowned.
 * Each role carries baked operating doctrine — the agent arrives competent.
 */
export function deriveCast(archetype: AppArchetype): CastRole[] {
  switch (archetype) {
    case 'sales':
      return [
        {
          role: 'sales_concierge', title: 'Concierge', operator: true, avatarGlyph: '🤝', colorHex: '#2563eb',
          capabilityTags: ['sales', 'conversation', 'qualification'],
          instructions:
            'You run this sales desk. Greet every contact warmly, understand what they need, qualify fit (budget, authority, need, timeline), and move real opportunities forward. Persist what you learn about each contact to the App datastore; flag deals that need a human and follow up when you promised to.',
        },
        {
          role: 'sales_qualifier', title: 'Qualifier', avatarGlyph: '🔎', colorHex: '#0ea5e9',
          capabilityTags: ['sales', 'qualification', 'discovery'],
          instructions:
            'You qualify inbound interest: ask focused discovery questions, capture budget/authority/need/timeline, and record the contact’s stage and goal. Hand a qualified, well-documented opportunity to the closer; politely disqualify poor fits.',
        },
        {
          role: 'sales_closer', title: 'Closer', avatarGlyph: '🎯', colorHex: '#7c3aed',
          capabilityTags: ['sales', 'negotiation', 'closing'],
          instructions:
            'You close qualified opportunities: handle objections honestly, propose next steps, and never promise terms you are not authorized to give — escalate pricing/discount approvals to the operator. Keep the deal record current.',
        },
      ];
    case 'support':
      return [
        {
          role: 'support_triage', title: 'Triage', operator: true, avatarGlyph: '🧭', colorHex: '#0d9488',
          capabilityTags: ['support', 'triage', 'conversation'],
          instructions:
            'You run this support desk. Greet each customer, understand the issue, resolve what you can directly, and route what you can’t to the right specialist or a human. Capture the ticket and its status in the App datastore.',
        },
        {
          role: 'support_resolver', title: 'Resolver', avatarGlyph: '🛠️', colorHex: '#059669',
          capabilityTags: ['support', 'resolution', 'knowledge'],
          instructions:
            'You resolve support issues with depth and rigor: reproduce, diagnose, ground every answer in real evidence, and never fabricate a fix. Update the ticket with the resolution and escalate honestly when blocked.',
        },
      ];
    case 'analytics':
      return [
        {
          role: 'analytics_operator', title: 'Analyst', operator: true, avatarGlyph: '📊', colorHex: '#d97706',
          capabilityTags: ['analytics', 'reporting', 'insight'],
          instructions:
            'You operate this analytics App. Turn the App’s data into clear, honest insight — surface what changed and why, never invent numbers, and write derived results back to the App’s collections so the interface stays live.',
        },
      ];
    case 'research':
      return [
        {
          role: 'research_operator', title: 'Researcher', operator: true, avatarGlyph: '🔭', colorHex: '#4f46e5',
          capabilityTags: ['research', 'monitoring', 'synthesis'],
          instructions:
            'You operate this research/monitoring App. Watch your sources, synthesize grounded findings with citations, abstain when evidence is thin, and persist each finding to the App’s collections so the interface reflects the latest signal.',
        },
      ];
    case 'automation':
    default:
      return [
        {
          role: 'app_operator', title: 'Operator', operator: true, avatarGlyph: '⚙️', colorHex: '#475569',
          capabilityTags: ['operations', 'automation'],
          instructions:
            'You operate this App. Run its workflows reliably, keep its data current, surface anything that needs a human, and never fabricate results to make a step pass.',
        },
      ];
  }
}

/** Convenience: derive the cast straight from an App's name + description. */
export function castForApp(name: string, description: string): { archetype: AppArchetype; cast: CastRole[] } {
  const archetype = classifyAppArchetype(name, description);
  return { archetype, cast: deriveCast(archetype) };
}
