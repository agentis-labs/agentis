import type { SurfaceAction, ViewNode } from '@agentis/core';

export interface InterfaceBenchmark {
  name: string;
  collections: string[];
  actions: SurfaceAction[];
  view: ViewNode;
  requiredBlocks: string[];
}

/**
 * Representative products used as a durable interface-quality floor. These are
 * intentionally domain-shaped rather than generic component galleries.
 */
export const interfaceBenchmarks: InterfaceBenchmark[] = [
  {
    name: 'sales pipeline',
    collections: ['deals', 'activity'],
    actions: [{ name: 'move-deal', kind: 'data', target: 'deals.update' }],
    requiredBlocks: ['Hero', 'KPIStrip', 'Kanban', 'ActivityStream'],
    view: {
      type: 'Stack',
      style: { theme: 'analytics', design: 'operations' },
      children: [
        { type: 'Hero', title: 'Revenue command center', subtitle: 'Move qualified deals and unblock the team.' },
        { type: 'KPIStrip', items: [{ label: 'Pipeline', value: '$540k', delta: '+12%' }, { label: 'Win rate', value: '31%' }] },
        {
          type: 'Split',
          ratio: 2,
          left: {
            type: 'Kanban',
            bind: { collection: 'deals', live: true },
            groupBy: 'stage',
            columns: ['discovered', 'qualified', 'proposal', 'won'],
            titleField: 'name',
            valueField: 'value',
            update: { action: 'move-deal' },
          },
          right: { type: 'ActivityStream', title: 'Live activity', limit: 20 },
        },
      ],
    },
  },
  {
    name: 'operations control room',
    collections: ['incidents'],
    actions: [],
    requiredBlocks: ['Hero', 'StatusBoard', 'Table', 'RunMonitor'],
    view: {
      type: 'Stack',
      style: { theme: 'operations', design: 'console', density: 'compact' },
      children: [
        { type: 'Hero', eyebrow: 'Live operations', title: 'Reliability control room' },
        { type: 'StatusBoard', title: 'Systems', items: [{ label: 'Ingestion', status: 'healthy' }, { label: 'Delivery', status: 'healthy' }] },
        { type: 'Table', bind: { collection: 'incidents', live: true }, columns: [{ key: 'severity', format: 'badge' }, { key: 'summary' }, { key: 'owner' }] },
        { type: 'RunMonitor', title: 'Automations', limit: 12, controls: true },
      ],
    },
  },
  {
    name: 'editorial intelligence',
    collections: ['stories'],
    actions: [],
    requiredBlocks: ['Hero', 'Chart', 'RecordMaster'],
    view: {
      type: 'Stack',
      style: { theme: 'editorial', design: 'editorial' },
      children: [
        { type: 'Hero', eyebrow: 'Morning brief', title: 'What matters now', subtitle: 'Evidence-ranked stories and coverage gaps.' },
        { type: 'Chart', bind: { collection: 'stories' }, chartType: 'bar', x: 'topic', y: 'mentions', height: 240 },
        { type: 'RecordMaster', bind: { collection: 'stories', live: true }, titleField: 'headline', subtitleField: 'summary', statusField: 'status', searchFields: ['headline', 'summary'] },
      ],
    },
  },
];
