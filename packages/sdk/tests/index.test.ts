import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeManifest } from '@agentis/core';
import {
  buildAgentisApp,
  createStarterApp,
  defineApp,
  defineCollection,
  defineSurface,
  defineWorkflow,
  field,
  validateAgentisApp,
} from '../src/index.js';

describe('@agentis/sdk App authoring', () => {
  it('emits the canonical App manifest and .agentisapp envelope', () => {
    const manifest = defineApp({
      name: 'Ops Desk',
      version: '1.2.3',
      workflows: [
        defineWorkflow({
          title: 'Route ticket',
          graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        }),
      ],
      surfaces: [
        defineSurface({
          name: 'home',
          view: { type: 'Stack', children: [{ type: 'Heading', value: 'Tickets' }] },
        }),
      ],
      collections: [
        defineCollection({
          name: 'tickets',
          schema: { fields: [field('subject', 'string', { required: true })] },
        }),
      ],
    });

    expect(manifest.identity).toMatchObject({ slug: 'ops-desk', name: 'Ops Desk', version: '1.2.3', entrySurfaceId: 'home' });
    expect(manifest.workflows).toHaveLength(1);
    expect(manifest.surfaces).toHaveLength(1);
    expect(manifest.collections).toHaveLength(1);

    const envelope = buildAgentisApp(manifest);
    const expectedChecksum = createHash('sha256').update(canonicalizeManifest(manifest)).digest('hex');
    expect(envelope.format).toBe('.agentisapp');
    expect(envelope.checksum).toBe(expectedChecksum);
    expect(validateAgentisApp(envelope)).toEqual(envelope);
  });

  it('creates a portable starter app with a working data/action surface', () => {
    const manifest = createStarterApp('Task Desk');
    expect(manifest.identity).toMatchObject({ slug: 'task-desk', name: 'Task Desk' });
    expect(manifest.collections[0]?.name).toBe('tasks');
    expect(manifest.surfaces[0]?.actions).toEqual([{ name: 'createTask', kind: 'data', target: 'tasks.insert' }]);
    expect(buildAgentisApp(manifest).manifest).toEqual(manifest);
  });
});
