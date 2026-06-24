import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import {
  HarnessMemoryIngestionService,
  type IngestibleAgent,
} from '../../src/services/harnessMemoryIngestion.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let tmp: string | null = null;
let store: EpisodicMemoryStore;
let service: HarnessMemoryIngestionService;

beforeEach(async () => {
  ctx = await createTestContext();
  store = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  service = new HarnessMemoryIngestionService(store, ctx.logger);
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agentis-harness-ingest-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
  ctx.close();
});

function agentWith(content: string): IngestibleAgent {
  writeFileSync(path.join(tmp!, 'CLAUDE.md'), content, 'utf8');
  return { id: 'agent1', workspaceId: ctx.workspace.id, adapterType: 'claude_code', config: { cwd: tmp! }, instructions: '' };
}

const RICH_INSTRUCTIONS = `# Project Conventions

## Table of Contents
- intro
- usage

## Rules
- Always run the test suite before pushing to main.
- Never commit secrets or API keys to the repository.
- Prefer composition over inheritance when designing services.

## Decisions
- We chose SQLite over Postgres for local-first deployments because operators run single-node.

## Notes
- TODO: fill this in later
- See above.
\`\`\`ts
const x = 1; // code fences must be ignored
\`\`\`
`;

describe('HarnessMemoryIngestionService', () => {
  it('distils harness instruction files into quality-gated candidates', () => {
    const preview = service.preview(agentWith(RICH_INSTRUCTIONS));
    const summaries = preview.candidates.map((c) => c.summary);

    // Strong rules are kept.
    expect(summaries.some((s) => /Always run the test suite/.test(s))).toBe(true);
    expect(summaries.some((s) => /Never commit secrets/.test(s))).toBe(true);
    // The decision is classified as a decision.
    const decision = preview.candidates.find((c) => /SQLite over Postgres/.test(c.summary));
    expect(decision?.type).toBe('decision');
  });

  it('rejects garbage: boilerplate headings, TODOs, pointers, and code fences', () => {
    const preview = service.preview(agentWith(RICH_INSTRUCTIONS));
    const summaries = preview.candidates.map((c) => c.summary.toLowerCase());

    expect(summaries.some((s) => s.includes('table of contents'))).toBe(false);
    expect(summaries.some((s) => s.includes('todo'))).toBe(false);
    expect(summaries.some((s) => s === 'see above.')).toBe(false);
    expect(summaries.some((s) => s.includes('const x = 1'))).toBe(false);
  });

  it('writes accepted candidates into the agent-private Brain', () => {
    const agent = agentWith(RICH_INSTRUCTIONS);
    const result = service.commit(agent);
    expect(result.written).toBeGreaterThan(0);

    const episodes = store.list({ workspaceId: ctx.workspace.id, scopeId: 'agent1' });
    expect(episodes.length).toBe(result.written);
    // Provenance + scope are correct.
    for (const ep of episodes) {
      expect(ep.source).toBe('harness_ingest');
      expect(ep.scopeId).toBe('agent1');
      expect(ep.agentId).toBe('agent1');
      const harness = ep.metadata.harness as Record<string, unknown> | undefined;
      expect(harness?.adapterType).toBe('claude_code');
      expect(typeof harness?.contentHash).toBe('string');
    }
  });

  it('is idempotent: re-ingesting unchanged files reinforces instead of duplicating', () => {
    const agent = agentWith(RICH_INSTRUCTIONS);
    const first = service.commit(agent);
    expect(first.written).toBeGreaterThan(0);

    const second = service.commit(agent);
    expect(second.written).toBe(0);
    expect(second.reinforced).toBe(first.written);

    // Total episode count did not grow on the second run.
    const episodes = store.list({ workspaceId: ctx.workspace.id, scopeId: 'agent1' });
    expect(episodes.length).toBe(first.written);
  });

  it('honours an explicit accept subset (human review path)', () => {
    const agent = agentWith(RICH_INSTRUCTIONS);
    const preview = service.preview(agent);
    const chosen = preview.candidates.find((c) => /Never commit secrets/.test(c.summary));
    expect(chosen).toBeDefined();

    const result = service.commit(agent, { acceptHashes: [chosen!.hash] });
    expect(result.written).toBe(1);

    const episodes = store.list({ workspaceId: ctx.workspace.id, scopeId: 'agent1' });
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.summary).toMatch(/Never commit secrets/);
  });

  it('returns no candidates when there is no harness memory to ingest', () => {
    const agent: IngestibleAgent = { id: 'agent1', workspaceId: ctx.workspace.id, adapterType: 'claude_code', config: { cwd: tmp! }, instructions: '' };
    const preview = service.preview(agent);
    expect(preview.candidates).toEqual([]);
  });
});
