import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { normalizeWorkflowGraph } from '../../src/services/workflow/workflowGraphNormalization.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('normalizeWorkflowGraph', () => {
  it('promotes filter nodes that return structured payloads into transform nodes', () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'filter_articles',
          type: 'filter',
          title: 'Filter Articles',
          position: { x: 0, y: 0 },
          config: {
            kind: 'filter',
            condition: 'const articles = input.articles || []; ({ articles: articles.filter((article) => article.keep) })',
          },
        },
      ],
      edges: [],
    };

    const normalized = normalizeWorkflowGraph(ctx.db, ctx.workspace.id, graph);
    const node = normalized.graph.nodes[0]!;

    expect(node.type).toBe('transform');
    expect(node.config).toEqual({
      kind: 'transform',
      expression: 'const articles = input.articles || []; ({ articles: articles.filter((article) => article.keep) })',
    });
    expect(normalized.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'filter_promoted_to_transform',
          nodeId: 'filter_articles',
        }),
      ]),
    );
  });

  it('normalizes legacy http_request responseMapping objects', () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'fetch_feed',
          type: 'http_request',
          title: 'Fetch Feed',
          position: { x: 0, y: 0 },
          config: {
            kind: 'http_request',
            method: 'GET',
            url: 'https://example.test/feed.xml',
            responseMapping: { raw: 'body' },
          },
        },
        {
          id: 'fetch_items',
          type: 'http_request',
          title: 'Fetch Items',
          position: { x: 260, y: 0 },
          config: {
            kind: 'http_request',
            method: 'GET',
            url: 'https://example.test/items.json',
            responseMapping: { items: 'data.items' },
          },
        },
      ],
      edges: [],
    };

    const normalized = normalizeWorkflowGraph(ctx.db, ctx.workspace.id, graph);
    const [feed, items] = normalized.graph.nodes;

    expect((feed!.config as { responseMapping?: unknown }).responseMapping).toEqual({ outputKey: 'raw' });
    expect((items!.config as { responseMapping?: unknown }).responseMapping).toEqual({
      outputKey: 'items',
      bodyPath: 'data.items',
    });
    expect(normalized.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'http_response_mapping_normalized', nodeId: 'fetch_feed' }),
        expect.objectContaining({ kind: 'http_response_mapping_normalized', nodeId: 'fetch_items' }),
      ]),
    );
  });

  it('normalizes legacy router branch ids and template conditions', () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'route-new-post-results',
          type: 'router',
          title: 'Route New Post Results',
          position: { x: 0, y: 0 },
          config: {
            kind: 'router',
            routingMode: 'first_match',
            branches: [
              { id: 'new-posts', condition: '{{nodes.select-unseen-posts.count}} > 0' },
              { id: 'no-new-posts', condition: '{{nodes.select-unseen-posts.count}} === 0' },
            ],
          },
        },
      ],
      edges: [],
    };

    const normalized = normalizeWorkflowGraph(ctx.db, ctx.workspace.id, graph);
    const node = normalized.graph.nodes[0]!;
    expect(node.config).toEqual({
      kind: 'router',
      routingMode: 'first_match',
      branches: [
        { branchId: 'new-posts', label: 'new-posts', condition: 'inputs["select-unseen-posts"].count > 0' },
        { branchId: 'no-new-posts', label: 'no-new-posts', condition: 'inputs["select-unseen-posts"].count == 0' },
      ],
    });
    expect(normalized.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'router_branch_shape_normalized', nodeId: 'route-new-post-results' }),
        expect.objectContaining({ kind: 'router_condition_normalized', nodeId: 'route-new-post-results' }),
      ]),
    );
  });
});
