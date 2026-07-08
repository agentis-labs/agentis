/**
 * Robustness-aware classifier + planner (WORKFLOW-DESIGN-10X Phase 3) — proves the
 * planner now emits gate / approval / validate Phase Cards (not just the linear
 * gather→analyze→draft→deliver line) when the request implies them, and stays flat
 * when it doesn't.
 */
import { describe, expect, it } from 'vitest';
import { classifyIntent, planWorkflow, type WorkspaceInventory } from '../../src/services/creationPipeline.js';

const emptyInventory: WorkspaceInventory = {
  availableAgents: [],
  configuredCredentials: [],
  availableExtensions: [],
  knowledgeBases: [],
  knowledgeExcerpts: [],
  wireableIntegrations: [],
  specialistRoles: [],
  workspaceContext: '',
};

describe('robustness-aware planning', () => {
  it('detects qualify/approval/validate signals and emits guard phases', () => {
    const desc =
      'Prospect Instagram clothing stores, qualify each candidate and reject the weak ones, then deploy the demo to Vercel only after I approve, and validate the live site returns 200';
    const c = classifyIntent(desc, emptyInventory);
    expect(c.robustness.qualifies).toBe(true);
    expect(c.robustness.approval).toBe(true);
    expect(c.robustness.validates).toBe(true);
    expect(c.robustness.irreversible).toBe(true);

    const kinds = planWorkflow(desc, c).phases.map((p) => p.kind);
    expect(kinds).toContain('gate');
    expect(kinds).toContain('approval');
    expect(kinds).toContain('validate');
  });

  it('stays a flat happy-path plan when no robustness signals are present', () => {
    const desc = 'Summarize the top Hacker News stories each morning and write a digest';
    const c = classifyIntent(desc, emptyInventory);
    expect(c.robustness.qualifies).toBe(false);
    expect(c.robustness.approval).toBe(false);

    const kinds = planWorkflow(desc, c).phases.map((p) => p.kind ?? 'work');
    expect(kinds).not.toContain('approval');
    expect(kinds).not.toContain('gate');
    expect(kinds.every((k) => k === 'work')).toBe(true);
  });
});
