/**
 * Starter app templates (masterplan 5.5). Instead of a blank canvas, the create
 * dialog offers a few real starting points — each a valid workflow graph passed
 * to `appsApi.create({ entryWorkflowGraph })`.
 */
export interface AppTemplate {
  id: string;
  name: string;
  description: string;
  /** undefined = blank (empty workflow). */
  graph?: Record<string, unknown>;
}

const viewport = { x: 0, y: 0, zoom: 1 };

export const APP_TEMPLATES: AppTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'Start from an empty canvas and build it yourself.',
  },
  {
    id: 'scheduled-digest',
    name: 'Scheduled digest',
    description: 'Runs on a schedule and produces a result — e.g. a morning summary.',
    graph: {
      version: 1,
      viewport,
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Every morning at 9am', position: { x: 0, y: 120 }, config: { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * *' } },
        { id: 'output', type: 'return_output', title: 'Digest', position: { x: 280, y: 120 }, config: { kind: 'return_output', renderAs: 'markdown' } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'output' }],
    },
  },
  {
    id: 'webhook-handler',
    name: 'Inbound webhook',
    description: 'Receives an external event, shapes it, and returns a result.',
    graph: {
      version: 1,
      viewport,
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Incoming webhook', position: { x: 0, y: 120 }, config: { kind: 'trigger', triggerType: 'webhook' } },
        { id: 'shape', type: 'transform', title: 'Shape the payload', position: { x: 280, y: 120 }, config: { kind: 'transform', expression: 'input' } },
        { id: 'output', type: 'return_output', title: 'Result', position: { x: 560, y: 120 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'shape' },
        { id: 'e2', source: 'shape', target: 'output' },
      ],
    },
  },
];
