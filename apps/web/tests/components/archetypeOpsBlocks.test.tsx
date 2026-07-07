/**
 * APP-INTERFACE-10X blocks — the archetype workhorses (Kanban / RecordMaster /
 * Roadmap / PipelineFlow) and the live-ops plane registrations. Proves they
 * register on the open seam, bind rows through the runtime client, and that
 * Kanban writes the groupBy field back through the declared update action.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentisAppClient } from '@agentis/app-client';
import type { ViewNode } from '@agentis/core';
import { RuntimeProvider, ViewRenderer } from '../../src/components/apps/ViewRenderer';
import { hasBlock } from '../../src/components/apps/blocks/registry';

vi.mock('socket.io-client', () => ({
  io: () => ({ on: () => {}, off: () => {}, emit: () => {}, disconnect: () => {}, io: { on: () => {} } }),
}));

// The ops blocks hit /v1/apps + /v1/runs + /v1/approvals through the api layer.
vi.mock('../../src/lib/appsApi', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/appsApi')>();
  return {
    ...mod,
    appsApi: {
      ...mod.appsApi,
      listWorkflows: vi.fn(async () => []),
    },
  };
});
vi.mock('../../src/lib/opsApi', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/opsApi')>();
  return {
    ...mod,
    opsApi: {
      ...mod.opsApi,
      listRuns: vi.fn(async () => []),
      listApprovals: vi.fn(async () => []),
    },
  };
});

function stubClient(rows: Array<Record<string, unknown>> = []) {
  const invoke = vi.fn(async () => ({}));
  const client = {
    data: { query: vi.fn(async () => rows) },
    state: { get: async () => undefined, set: async () => {}, subscribe: () => () => {} },
    actions: { invoke },
    navigation: { go: async () => {} },
    realtime: { subscribe: () => () => {} },
    files: { upload: async () => { throw new Error('unsupported'); } },
  } as unknown as AgentisAppClient;
  return { client, invoke };
}

function renderNode(node: ViewNode, rows: Array<Record<string, unknown>> = []) {
  const { client, invoke } = stubClient(rows);
  const utils = render(
    <RuntimeProvider value={{ appId: 'app-1', surface: 'main', client, surfaceActions: [{ name: 'update_leads', kind: 'data', target: 'leads.update' }], uiState: {}, allowCustomCode: false, dataRevision: 0 }}>
      <ViewRenderer node={node} />
    </RuntimeProvider>,
  );
  return { ...utils, invoke };
}

describe('block registrations (open seam)', () => {
  it('registers the archetype + live-ops kinds, and WorkflowControl stays aliased', () => {
    for (const kind of ['Kanban', 'RecordMaster', 'Roadmap', 'PipelineFlow', 'OrchestrationPanel', 'RunMonitor', 'AgentFeed', 'ApprovalsInbox', 'WorkflowControl']) {
      expect(hasBlock(kind), `missing block: ${kind}`).toBe(true);
    }
  });
});

describe('Kanban', () => {
  const rows = [
    { id: 'r1', name: 'Acme', stage: 'new', amount: 1200 },
    { id: 'r2', name: 'Globex', stage: 'won', amount: 800 },
  ];
  const node: ViewNode = {
    type: 'Kanban',
    bind: { collection: 'leads', live: true },
    groupBy: 'stage',
    titleField: 'name',
    valueField: 'amount',
    update: { action: 'update_leads' },
  };

  it('groups rows into columns with counts', async () => {
    renderNode(node, rows);
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(screen.getByText('Globex')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Won')).toBeTruthy();
  });

  it('drop on another column dispatches the update action with {id, patch}', async () => {
    const { invoke } = renderNode(node, rows);
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    const card = screen.getByText('Acme').closest('[draggable]') as HTMLElement;
    const wonHeader = screen.getByText('Won').closest('.s-round') as HTMLElement;
    expect(card).toBeTruthy();
    expect(wonHeader).toBeTruthy();
    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) { this.data[type] = value; },
      getData(type: string) { return this.data[type] ?? ''; },
      effectAllowed: '',
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(wonHeader, { dataTransfer });
    fireEvent.drop(wonHeader, { dataTransfer });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_leads', { id: 'r1', patch: { stage: 'won' } }));
  });
});

describe('RecordMaster', () => {
  it('renders the master list and the selected record page', async () => {
    renderNode(
      {
        type: 'RecordMaster',
        bind: { collection: 'contacts', live: true },
        titleField: 'name',
        statusField: 'status',
      },
      [
        { id: 'c1', name: 'Ada Lovelace', email: 'ada@calc.io', status: 'active' },
        { id: 'c2', name: 'Alan Turing', email: 'alan@bletchley.uk', status: 'paused' },
      ],
    );
    await waitFor(() => expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0));
    // First record selected by default → its record page shows the email field
    // (the email also appears as the master-list subtitle, hence getAllByText).
    expect(screen.getAllByText('ada@calc.io').length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText('Search…')).toBeTruthy();
  });
});

describe('PipelineFlow', () => {
  it('computes stage counts and conversion', async () => {
    renderNode(
      { type: 'PipelineFlow', bind: { collection: 'leads', live: true }, stageField: 'stage', valueField: 'amount' },
      [
        { id: '1', stage: 'new', amount: 100 },
        { id: '2', stage: 'new', amount: 50 },
        { id: '3', stage: 'won', amount: 70 },
      ],
    );
    await waitFor(() => expect(screen.getByText('New')).toBeTruthy());
    expect(screen.getByText('2')).toBeTruthy(); // new count
    expect(screen.getByText('50%')).toBeTruthy(); // conversion new → won
  });
});

describe('Roadmap', () => {
  it('draws lane bars from date fields', async () => {
    renderNode(
      { type: 'Roadmap', bind: { collection: 'releases', live: true }, labelField: 'title', startField: 'start', endField: 'end', laneField: 'track' },
      [
        { id: '1', title: 'v1 launch', start: '2026-07-01', end: '2026-07-20', track: 'core' },
        { id: '2', title: 'mobile beta', start: '2026-07-10', end: '2026-08-01', track: 'mobile' },
      ],
    );
    await waitFor(() => expect(screen.getByText('v1 launch')).toBeTruthy());
    expect(screen.getByText('mobile beta')).toBeTruthy();
    expect(screen.getByText('Core')).toBeTruthy();
    expect(screen.getByText('Mobile')).toBeTruthy();
  });
});
