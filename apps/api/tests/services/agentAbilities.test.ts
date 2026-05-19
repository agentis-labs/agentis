/**
 * Agent Abilities (BRAIN-ABILITIES-REPLAN.md Part IV) — validation.
 *
 * Covers CRUD + immutable versioning, the background reviewer's procedural
 * distillation, and relevance-ranked dispatch injection.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentAbilityService } from '../../src/services/agentAbilityService.js';
import { AgentAbilityReviewer } from '../../src/services/agentAbilityReviewer.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let abilities: AgentAbilityService;
let reviewer: AgentAbilityReviewer;
const agentId = randomUUID();

beforeEach(async () => {
  ctx = await createTestContext();
  abilities = new AgentAbilityService(ctx.db, ctx.bus, ctx.logger);
  reviewer = new AgentAbilityReviewer(ctx.db, abilities, ctx.logger);
});

afterEach(() => {
  ctx.close();
});

describe('AgentAbilityService — versioning (U4)', () => {
  it('patch creates a new immutable version and supersedes the old row', async () => {
    const v1 = await abilities.create({
      workspaceId: ctx.workspace.id,
      agentId,
      title: 'B2B Prospect Research',
      content: 'Start with LinkedIn for role tenure.',
      source: 'operator_write',
    });
    expect(v1.version).toBe(1);

    const v2 = await abilities.patch(ctx.workspace.id, v1.id, {
      content: 'Start with LinkedIn, then check company job postings for tech stack.',
      changeNote: 'added job-posting signal',
    });
    expect(v2?.version).toBe(2);
    expect(v2?.parentAbilityId).toBe(v1.id);
    expect(v2?.changelog[0]).toContain('job-posting');

    // Old row is superseded — never injected again.
    const old = abilities.get(ctx.workspace.id, v1.id);
    expect(old?.status).toBe('superseded');

    // The active list shows only v2.
    const active = abilities.list(ctx.workspace.id, { agentId });
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(2);

    // History chains v2 → v1.
    const history = abilities.history(ctx.workspace.id, v2!.id);
    expect(history.map((h) => h.version)).toEqual([2, 1]);
  });

  it('rollback restores prior content via a new audited row', async () => {
    const v1 = await abilities.create({
      workspaceId: ctx.workspace.id,
      agentId,
      title: 'Cold Email Approach',
      content: 'Lead with a technical observation.',
      source: 'operator_write',
    });
    const v2 = await abilities.patch(ctx.workspace.id, v1.id, { content: 'Lead with pricing.' });
    const rolled = await abilities.rollback(ctx.workspace.id, v1.id);
    expect(rolled?.content).toBe('Lead with a technical observation.');
    expect(rolled?.source).toBe('operator_rollback');
    expect(rolled?.version).toBeGreaterThan(v2!.version);
  });
});

describe('AgentAbilityReviewer — procedural distillation (Path 1)', () => {
  it('distils a multi-step procedure from a run into an ability', async () => {
    const result = await reviewer.review({
      workspaceId: ctx.workspace.id,
      agentId,
      runId: randomUUID(),
      taskTitle: 'Research an enterprise prospect',
      taskOutput: {
        summary: 'Completed prospect research.',
        result:
          '1. Check LinkedIn for role tenure and growth signals.\n' +
          '2. Review the company job postings to infer the tech stack.\n' +
          '3. Cross-reference recent news for funding triggers.\n' +
          'Technical depth outperformed generic openers by 3x for this segment.',
      },
      thinkingTrace: ['Start with LinkedIn.', 'Verify the tech stack from job postings.'],
    });
    expect(result?.created).toBe(true);
    const list = abilities.list(ctx.workspace.id, { agentId });
    expect(list).toHaveLength(1);
    expect(list[0]?.content).toContain('Approach:');
    expect(list[0]?.source).toBe('background_review');
  });

  it('does not write an ability when the run exposed no procedure', async () => {
    const result = await reviewer.review({
      workspaceId: ctx.workspace.id,
      agentId,
      taskOutput: { summary: 'ok' },
    });
    expect(result).toBeNull();
  });
});

describe('Ability dispatch injection (Part IV)', () => {
  it('ranks abilities by task relevance and renders an injection block', async () => {
    await abilities.create({
      workspaceId: ctx.workspace.id,
      agentId,
      title: 'B2B Prospect Research',
      content: 'Research a prospect by checking LinkedIn tenure and company job postings.',
      source: 'operator_write',
    });
    await abilities.create({
      workspaceId: ctx.workspace.id,
      agentId,
      title: 'Invoice Reconciliation',
      content: 'Match invoice line items against the purchase order ledger.',
      source: 'operator_write',
    });

    const block = await abilities.buildDispatchBlock({
      workspaceId: ctx.workspace.id,
      agentId,
      taskDescription: 'Research a B2B prospect on LinkedIn before outreach',
    });
    expect(block.block).toContain('AGENT ABILITIES');
    expect(block.abilityIds.length).toBeGreaterThan(0);

    // usageCount was bumped for the injected abilities.
    const injected = abilities.get(ctx.workspace.id, block.abilityIds[0]!);
    expect(injected?.usageCount).toBe(1);
  });
});
