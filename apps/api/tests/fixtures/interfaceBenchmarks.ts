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
    name: 'prospecting pipeline',
    collections: ['deals', 'activity'],
    actions: [{ name: 'move-deal', kind: 'data', target: 'deals.update' }],
    requiredBlocks: ['Toolbar', 'PipelineFlow', 'Kanban', 'ActivityStream'],
    view: {
      type: 'Stack',
      style: { theme: 'analytics', design: 'operations' },
      children: [
        { type: 'Toolbar', title: 'Qualified opportunities', children: [{ type: 'Badge', value: 'WhatsApp verified', tone: 'success' }] },
        { type: 'PipelineFlow', bind: { collection: 'deals', live: true }, stageField: 'stage', valueField: 'value' },
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
    name: 'customer support inbox',
    collections: ['tickets', 'messages'],
    actions: [
      { name: 'reply', kind: 'data', target: 'messages.insert' },
      { name: 'create-ticket', kind: 'data', target: 'tickets.insert' },
    ],
    requiredBlocks: ['Toolbar', 'Inbox', 'StatusBoard', 'Form'],
    view: {
      type: 'Stack',
      style: { theme: 'product', design: 'operations', density: 'compact' },
      children: [
        { type: 'Toolbar', title: 'Support queue', children: [{ type: 'Badge', value: 'SLA monitored', tone: 'warning' }] },
        { type: 'StatusBoard', items: [{ label: 'First response', status: 'on target', detail: '8 min median' }, { label: 'Escalations', status: 'attention', detail: '3 open' }] },
        { type: 'Inbox', source: 'collection', bind: { collection: 'tickets', live: true }, titleField: 'subject', subtitleField: 'customer', channelField: 'channel', messagesBind: { collection: 'messages', live: true }, messageRoleField: 'role', messageContentField: 'body', matchField: 'ticket_id', send: { action: 'reply' } },
        { type: 'Accordion', sections: [{ title: 'Open ticket', children: [{ type: 'Form', fields: [{ key: 'subject', label: 'Subject', type: 'text', required: true }, { key: 'customer', label: 'Customer', type: 'text' }], submit: { action: 'create-ticket' }, submitLabel: 'Open ticket' }] }] },
      ],
    },
  },
  {
    name: 'relationship workspace',
    collections: ['accounts'],
    actions: [{ name: 'create-account', kind: 'data', target: 'accounts.insert' }],
    requiredBlocks: ['Heading', 'RecordMaster', 'Timeline', 'Form'],
    view: {
      type: 'Stack',
      style: { theme: 'editorial', design: 'editorial' },
      children: [
        { type: 'Heading', value: 'Accounts and relationships' },
        { type: 'Split', ratio: 2, left: { type: 'RecordMaster', bind: { collection: 'accounts', live: true }, titleField: 'name', subtitleField: 'company', statusField: 'health', searchFields: ['name', 'company'] }, right: { type: 'Timeline', title: 'Relationship history', bind: { collection: 'accounts', live: true }, titleField: 'last_event', detailField: 'note', atField: 'updated_at' } },
        { type: 'Accordion', sections: [{ title: 'Add account', children: [{ type: 'Form', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'company', label: 'Company', type: 'text' }], submit: { action: 'create-account' } }] }] },
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
