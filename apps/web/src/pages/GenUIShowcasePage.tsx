/**
 * GenUIShowcasePage — a DEV-only gallery that renders the real AG-UI
 * `ViewRenderer` against representative archetype surfaces with an in-memory
 * data client. It needs no API/model, so it's a faithful, self-contained proof
 * that the renderer produces designer-grade, themed, data-bound interfaces.
 *
 * Reached at /genui-showcase only when import.meta.env.DEV (see App.tsx).
 */
import { useEffect, useMemo, useState } from 'react';
import type { AgentisAppClient } from '@agentis/app-client';
import type { ViewNode } from '@agentis/core';
import { RuntimeProvider, ViewRenderer } from '../components/apps/ViewRenderer';

// ── In-memory datasets the bound nodes read ─────────────────
const DATA: Record<string, Array<Record<string, unknown>>> = {
  revenue: [
    { month: 'Jan', mrr: 30, expansion: 6 }, { month: 'Feb', mrr: 33, expansion: 7 },
    { month: 'Mar', mrr: 35, expansion: 9 }, { month: 'Apr', mrr: 38, expansion: 8 },
    { month: 'May', mrr: 41, expansion: 11 }, { month: 'Jun', mrr: 44, expansion: 12 },
    { month: 'Jul', mrr: 46, expansion: 13 }, { month: 'Aug', mrr: 48, expansion: 15 },
  ],
  channels: [
    { channel: 'Organic', visits: 3200 }, { channel: 'Paid', visits: 1800 },
    { channel: 'Referral', visits: 1200 }, { channel: 'Social', visits: 900 },
  ],
  accounts: [
    { name: 'Acme Corp', plan: 'Enterprise', mrr: 4200, status: 'active' },
    { name: 'Globex', plan: 'Growth', mrr: 1800, status: 'active' },
    { name: 'Initech', plan: 'Starter', mrr: 290, status: 'trial' },
    { name: 'Umbrella', plan: 'Enterprise', mrr: 5100, status: 'active' },
    { name: 'Hooli', plan: 'Growth', mrr: 1500, status: 'past_due' },
  ],
  requests: [
    { hour: '08:00', count: 120 }, { hour: '09:00', count: 340 }, { hour: '10:00', count: 280 },
    { hour: '11:00', count: 410 }, { hour: '12:00', count: 360 }, { hour: '13:00', count: 290 },
  ],
  deals: [
    { name: 'Northwind', stage: 'Lead', value: 12 }, { name: 'Contoso', stage: 'Lead', value: 8 },
    { name: 'Fabrikam', stage: 'Qualified', value: 24 }, { name: 'Tailspin', stage: 'Qualified', value: 18 },
    { name: 'Wingtip', stage: 'Negotiation', value: 40 }, { name: 'Adventure Works', stage: 'Won', value: 65 },
  ],
};

function stubClient(): AgentisAppClient {
  return {
    data: { query: async (collection: string) => DATA[collection] ?? [] },
    state: { get: async () => undefined, set: async () => {}, subscribe: () => () => {} },
    actions: { invoke: async () => ({}) },
    navigation: { go: async () => {} },
    realtime: { subscribe: () => () => {} },
    files: { upload: async () => { throw new Error('unsupported'); } },
  } as unknown as AgentisAppClient;
}

// ── Surfaces (the new vocabulary, themed per archetype) ─────

const ANALYTICS: ViewNode = {
  type: 'Stack',
  gap: 16,
  style: { theme: 'analytics' },
  children: [
    { type: 'Hero', eyebrow: 'ANALYTICS', title: 'Revenue analytics', subtitle: 'Live metrics the operator keeps current — no human writing code.', actions: [{ action: 'export_report' }, { action: 'share' }] },
    {
      type: 'KPIStrip',
      items: [
        { label: 'MRR', value: '$48.2k', delta: '▲ 8.1%', tone: 'success', spark: [30, 33, 35, 38, 41, 44, 48] },
        { label: 'Active accounts', value: '1,284', delta: '▲ 3.4%', tone: 'success', spark: [11, 12, 12, 13, 13, 14, 15] },
        { label: 'Churn', value: '1.9%', delta: '▼ 0.3%', tone: 'danger', spark: [3, 2.6, 2.4, 2.2, 2.1, 2.0, 1.9] },
        { label: 'NPS', value: '62', delta: '▲ 5', tone: 'accent', spark: [48, 50, 53, 55, 58, 60, 62] },
      ],
    },
    {
      type: 'Grid',
      columns: 3,
      gap: 16,
      children: [
        { type: 'Card', title: 'MRR & expansion', style: { span: 2 }, children: [{ type: 'Chart', bind: { collection: 'revenue', live: true }, chartType: 'area', x: 'month', y: 'mrr', series: [{ y: 'mrr', label: 'MRR' }, { y: 'expansion', label: 'Expansion' }], area: true, curve: 'smooth', legend: true, height: 240 }] },
        { type: 'Card', title: 'Traffic by channel', style: { span: 1 }, children: [{ type: 'Chart', bind: { collection: 'channels', live: true }, chartType: 'donut', x: 'channel', y: 'visits', height: 240 }] },
      ],
    },
    { type: 'Card', title: 'Accounts', children: [{ type: 'Table', bind: { collection: 'accounts', live: true }, columns: [{ key: 'name', label: 'Account' }, { key: 'plan', label: 'Plan' }, { key: 'mrr', label: 'MRR', format: 'number' }, { key: 'status', label: 'Status', format: 'badge' }] }] },
  ],
};

const CONSOLE: ViewNode = {
  type: 'Stack',
  gap: 16,
  style: { theme: 'console', density: 'compact' },
  children: [
    { type: 'Hero', eyebrow: 'OPERATOR', title: 'Mission control', subtitle: 'A dense ops command center — tabs and rails instead of one giant scroll.' },
    {
      type: 'Split',
      ratio: 2,
      left: {
        type: 'Tabs',
        tabs: [
          { label: 'Throughput', children: [
            { type: 'Card', title: 'Requests / hour', children: [{ type: 'Chart', bind: { collection: 'requests', live: true }, chartType: 'bar', x: 'hour', y: 'count', height: 200 }] },
            { type: 'Card', title: 'Accounts', children: [{ type: 'Table', bind: { collection: 'accounts', live: true }, columns: [{ key: 'name', label: 'Account' }, { key: 'mrr', label: 'MRR', format: 'number' }, { key: 'status', label: 'Status', format: 'badge' }] }] },
          ] },
          { label: 'Add account', children: [
            { type: 'Form', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'plan', label: 'Plan', type: 'select', options: [{ value: 'starter', label: 'Starter' }, { value: 'growth', label: 'Growth' }, { value: 'enterprise', label: 'Enterprise' }] }, { key: 'mrr', label: 'MRR', type: 'number' }], submit: { action: 'create_account' }, submitLabel: 'Add account' },
          ] },
        ],
      },
      right: {
        type: 'Stack',
        gap: 12,
        children: [
          { type: 'Callout', title: 'Degraded', value: '2 services are above latency budget.', style: { tone: 'warning' } },
          { type: 'Card', title: 'Service health', children: [
            { type: 'ProgressBar', label: 'API uptime', value: 99 },
            { type: 'ProgressBar', label: 'Queue drain', value: 72, style: { tone: 'warning' } },
            { type: 'ProgressBar', label: 'Error budget', value: 38, style: { tone: 'danger' } },
          ] },
          { type: 'Timeline', title: 'Recent events', items: [
            { title: 'Deployed v2.3.1', at: '09:12', tone: 'success' },
            { title: 'Latency spike on /search', at: '09:40', tone: 'warning' },
            { title: 'Auto-scaled +3 workers', at: '09:41', tone: 'accent' },
            { title: 'Recovered', at: '09:48', tone: 'success' },
          ] },
        ],
      },
    },
  ],
};

const PIPELINE: ViewNode = {
  type: 'Stack',
  gap: 16,
  style: { theme: 'product' },
  children: [
    { type: 'Hero', eyebrow: 'PIPELINE', title: 'Sales pipeline', subtitle: 'A consumer-grade board — the operator moves cards and chases the busywork.' },
    {
      type: 'KPIStrip',
      items: [
        { label: 'Open deals', value: '24', tone: 'accent' },
        { label: 'Weighted', value: '$182k', delta: '▲ 12%', tone: 'success' },
        { label: 'Win rate', value: '41%', tone: 'neutral' },
        { label: 'Avg cycle', value: '18d', tone: 'neutral' },
      ],
    },
    { type: 'Card', title: 'Deals by stage', children: [{ type: 'DataBoard', bind: { collection: 'deals', live: true }, groupBy: 'stage', titleField: 'name' }] },
  ],
};

const CODE: ViewNode = {
  type: 'Stack',
  gap: 16,
  style: { theme: 'console' },
  children: [
    { type: 'Hero', eyebrow: 'CODE SURFACE', title: 'Full-power tier', subtitle: 'When the typed grammar is not enough, the agent writes JS — sandboxed, on-brand, and live.' },
    {
      type: 'CodeSurface',
      collections: ['accounts'],
      height: 560,
      code: `
        const rows = await agentis.data.query('accounts', { limit: 50 });
        const total = rows.reduce(function (a, r) { return a + (Number(r.mrr) || 0); }, 0);
        root.appendChild(ui.heading('Accounts (agent-coded)'));
        root.appendChild(ui.text('Written as plain JS, rendered live in the hardened null-origin sandbox.'));
        root.appendChild(ui.row(
          ui.metric('Accounts', String(rows.length)),
          ui.metric('Total MRR', '$' + total.toLocaleString()),
          ui.metric('Enterprise', String(rows.filter(function (r) { return r.plan === 'Enterprise'; }).length))
        ));
        root.appendChild(ui.card('MRR by account', ui.chart.bar(rows, 'name', 'mrr')));
        root.appendChild(ui.card('Accounts', ui.table(rows, ['name', 'plan', 'mrr', 'status'])));
      `,
    },
  ],
};

const SURFACES: Array<{ key: string; label: string; node: ViewNode }> = [
  { key: 'analytics', label: 'Analytics dashboard', node: ANALYTICS },
  { key: 'console', label: 'Ops command center', node: CONSOLE },
  { key: 'pipeline', label: 'Pipeline / CRM', node: PIPELINE },
  { key: 'code', label: 'Code surface', node: CODE },
];

function surfaceIndexFromHash(): number {
  const key = window.location.hash.replace('#', '');
  const i = SURFACES.findIndex((s) => s.key === key);
  return i >= 0 ? i : 0;
}

export function GenUIShowcasePage() {
  const client = useMemo(() => stubClient(), []);
  const [active, setActive] = useState(surfaceIndexFromHash);
  useEffect(() => {
    const onHash = () => setActive(surfaceIndexFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const current = SURFACES[active] ?? SURFACES[0]!;

  return (
    <div className="min-h-screen bg-canvas px-6 py-6 text-text-primary">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center gap-3">
          <span className="text-[13px] font-semibold">GenUI Renaissance — agent-authored surfaces</span>
          <div className="ml-auto flex gap-1 rounded-btn border border-line bg-surface p-1">
            {SURFACES.map((s, i) => (
              <button
                key={s.key}
                type="button"
                onClick={() => { window.location.hash = s.key; setActive(i); }}
                className={`rounded-[6px] px-3 py-1.5 text-[12px] font-medium ${i === active ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <RuntimeProvider value={{ appId: 'showcase', surface: current.key, client, surfaceActions: [], uiState: {}, allowCustomCode: true, dataRevision: 0 }}>
          <ViewRenderer node={current.node} editable={false} />
        </RuntimeProvider>
      </div>
    </div>
  );
}
