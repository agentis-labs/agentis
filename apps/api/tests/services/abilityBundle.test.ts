/**
 * Phase 7C bundle install — abilities + pins round-trip through the packager.
 *
 * Builds an .agentiswf-style AgentisPackageContents that contains an agent + an
 * ability + a pin slug, installs it into a fresh workspace, and verifies the
 * ability lands compiled-pending, the agent exists, and the pin wires through.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisPackageContents } from '@agentis/core';
import { AbilityService } from '../../src/services/abilityService.js';
import { PackagerService } from '../../src/services/packager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let abilities: AbilityService;
let packager: PackagerService;

beforeEach(async () => {
  ctx = await createTestContext();
  abilities = new AbilityService(ctx.db, ctx.logger);
  packager = new PackagerService({ db: ctx.db, logger: ctx.logger, abilities });
});

afterEach(() => {
  ctx.close();
});

describe('PackagerService — agentis bundle abilities', () => {
  it('installs an agentis bundle with abilities and pins them to the bundled agent', () => {
    const contents: AgentisPackageContents = {
      kind: 'agentis',
      agents: [{
        name: 'UI Specialist',
        adapterType: 'hermes',
        capabilityTags: ['ui'],
        config: {},
        instructions: null,
        avatarGlyph: null,
        runtimeModel: null,
        role: 'worker',
        pinnedAbilitySlugs: ['senior-ui-engineer'],
      }],
      extensions: [],
      workflows: [],
      integrations: [],
      abilities: [{
        name: 'Senior UI Engineer',
        slug: 'senior-ui-engineer',
        version: '1.0.0',
        domain_tag: 'ui_engineering',
        icon_emoji: '🎨',
        description: 'React + Tailwind specialist',
        compiled_prompt: 'You are a Senior UI Engineer.',
        specs: { stack: 'React 19' },
        rules_always: ['Use semantic HTML'],
        rules_never: ['Inline styles'],
        tool_hints: [],
        examples: [{
          input_text: 'Build a pricing table',
          output_text: 'Here is a Tailwind grid ...',
          quality_score: 0.9,
          source: 'user_curated',
        }],
        knowledge: [{
          title: '8px grid',
          content: 'Tailwind spacing follows an 8px base unit.',
          importance_score: 0.7,
          source_type: 'document',
        }],
      }],
      credentialSlots: [],
      knowledgeSeeds: [],
      screenshotUrls: [],
    };

    const scope = { workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id };
    const pkgRow = packager.create(scope, { name: 'UI Suite', version: '1.0.0' }, 'agentis', contents);
    const result = packager.usePackage(scope, pkgRow.id);
    expect(result.kind).toBe('agentis');

    const installedAbilities = abilities.list(ctx.workspace.id);
    expect(installedAbilities).toHaveLength(1);
    const ability = installedAbilities[0]!;
    expect(ability.name).toBe('Senior UI Engineer');
    expect(ability.compiledPrompt).toContain('Senior UI Engineer');
    expect(ability.exampleCount).toBe(1);
    expect(ability.knowledgeCount).toBe(1);

    const installedAgents = ctx.db.select().from(schema.agents)
      .where(eq(schema.agents.workspaceId, ctx.workspace.id)).all();
    expect(installedAgents).toHaveLength(1);
    const agent = installedAgents[0]!;
    expect(agent.name).toBe('UI Specialist');

    const pins = abilities.listPinsForAgent(agent.id);
    expect(pins).toHaveLength(1);
    expect(pins[0]!.abilityId).toBe(ability.id);
    expect(pins[0]!.enabled).toBe(true);
  });

  it('skips unknown pin slugs without failing the install', () => {
    const contents: AgentisPackageContents = {
      kind: 'agentis',
      agents: [{
        name: 'Bare Agent',
        adapterType: 'hermes',
        capabilityTags: [],
        config: {},
        instructions: null,
        avatarGlyph: null,
        runtimeModel: null,
        role: 'worker',
        pinnedAbilitySlugs: ['does-not-exist'],
      }],
      extensions: [],
      workflows: [],
      integrations: [],
      abilities: [],
      credentialSlots: [],
      knowledgeSeeds: [],
      screenshotUrls: [],
    };
    const scope = { workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id };
    const pkgRow = packager.create(scope, { name: 'Bare bundle', version: '1.0.0' }, 'agentis', contents);
    expect(() => packager.usePackage(scope, pkgRow.id)).not.toThrow();
    const installedAgents = ctx.db.select().from(schema.agents)
      .where(eq(schema.agents.workspaceId, ctx.workspace.id)).all();
    expect(installedAgents).toHaveLength(1);
    expect(abilities.listPinsForAgent(installedAgents[0]!.id)).toHaveLength(0);
  });
});
