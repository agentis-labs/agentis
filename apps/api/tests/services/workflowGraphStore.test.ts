import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { syncNormalizedWorkflowGraph } from '../../src/services/workflowGraphStore.js';
import { createTestContext } from '../_helpers/createTestContext.js';

const workflowId = randomUUID();

describe('syncNormalizedWorkflowGraph', () => {
  it('mirrors nodes, edges, and subflow metadata', async () => {
    const ctx = await createTestContext();
    try {
      ctx.db.insert(schema.workflows).values({
        id: workflowId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        title: 'Mirrored workflow',
        graph: { version: 1, nodes: [], edges: [], variables: [], viewport: { x: 0, y: 0, zoom: 1 } },
        settings: {},
      }).run();

      syncNormalizedWorkflowGraph(ctx.db, workflowId, {
        version: 1,
        nodes: [
          {
            id: 'trigger',
            type: 'trigger',
            title: 'Manual',
            position: { x: 0, y: 0 },
            config: { kind: 'trigger', triggerType: 'manual' },
          },
          {
            id: 'loop',
            type: 'loop',
            title: 'Loop',
            position: { x: 200, y: 0 },
            config: { kind: 'loop', mode: 'count', count: 2, nodeIds: ['agent'] },
          },
        ],
        edges: [{ id: 'edge-1', source: 'trigger', target: 'loop' }],
        variables: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });

      expect(ctx.db.select().from(schema.workflowNodes).all()).toHaveLength(2);
      expect(ctx.db.select().from(schema.workflowEdges).all()).toHaveLength(1);
      const subflow = ctx.db.select().from(schema.workflowSubflows).get();
      expect(subflow).toMatchObject({ subflowId: 'loop', type: 'loop', nodeIds: ['agent'] });
    } finally {
      ctx.close();
    }
  });
});
