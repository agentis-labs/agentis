import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const demoRoot = join(here, '..');
const outFile = join(demoRoot, 'bundles', 'agentis-technical-command-lab.agentis.json');

const now = '2026-07-07T12:00:00.000Z';

const agents = [
  agent('The Brain', 'manager', ['orchestration', 'planning', 'governance'], 'Coordinates every app manager, decomposes operator missions, and escalates irreversible actions.'),
  agent('Engineering Manager', 'manager', ['repo-health', 'release-readiness'], 'Owns technical readiness across repos. Delegates audits, tests, documentation, and CI fixes.'),
  agent('Automation Manager', 'manager', ['schedules', 'webhooks', 'integrations'], 'Owns recurring workflows, mock integrations, retries, and operator-safe automation.'),
  agent('Research Manager', 'manager', ['research', 'citations', 'knowledge'], 'Owns sourced research, claim quality, and knowledge ingestion.'),
  agent('Launch Manager', 'manager', ['content', 'release-notes', 'screenshots'], 'Owns demos, launch assets, publishing queues, and screenshot checklists.'),
  agent('Operator Ops Manager', 'manager', ['follow-ups', 'budget', 'relationships'], 'Owns people, decisions, personal project follow-ups, and lightweight budget gates.'),
  agent('Code Review Specialist', 'specialist', ['code-review', 'static-analysis'], 'Audits diffs and turns risks into release blockers with clear owner/action fields.'),
  agent('CI Specialist', 'specialist', ['ci', 'tests'], 'Reads test signals, isolates flakes, and proposes deterministic verification loops.'),
  agent('Scheduler Specialist', 'specialist', ['cron', 'workflow-rules'], 'Designs schedules, chain rules, and failure recovery policies.'),
  agent('Citation Specialist', 'specialist', ['citations', 'evidence'], 'Ranks sources and refuses unsourced claims.'),
  agent('Screenshot Specialist', 'specialist', ['screenshots', 'video'], 'Builds capture lists for landing pages, docs, and launch videos.'),
  agent('Budget Specialist', 'specialist', ['budget', 'approval'], 'Checks spend thresholds and routes operator approvals before irreversible actions.'),
];

const apps = [
  commandCenterApp(),
  repoControlApp(),
  automationLabApp(),
  researchDeskApp(),
  launchStudioApp(),
  operatorDeskApp(),
];

const manifest = {
  agents,
  extensions: [],
  workflows: [],
  integrations: mockIntegrations(),
  apps,
  knowledgeSeeds: knowledgeSeeds(),
  credentialSlots: [],
};

const envelope = {
  format: '.agentis',
  formatVersion: 1,
  agentisVersion: '1.0.0',
  profile: 'share',
  name: 'Agentis Technical Command Lab',
  description: 'A multi-app demo workspace for technical operators: managers, specialists, workflows, approvals, knowledge, and mock integrations.',
  manifest,
  checksum: sha256(stableJson(manifest)),
  exportedAt: now,
  author: { id: 'nexseed-demo', displayName: 'Nexseed' },
  license: 'Apache-2.0 demo content. Contains only synthetic data and mock integrations.',
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(envelope, null, 2)}\n`);
console.log(`wrote ${outFile}`);
console.log(`apps=${apps.length} agents=${agents.length} knowledgeSeeds=${manifest.knowledgeSeeds.length}`);

function agent(name, role, capabilityTags, instructions) {
  return {
    name,
    adapterType: 'http',
    capabilityTags,
    config: { mode: 'demo', endpoint: 'mock://agentis-demo-runtime' },
    instructions,
    avatarGlyph: name.split(' ').map((part) => part[0]).join('').slice(0, 3),
    runtimeModel: 'demo-deterministic',
    role,
    monthlyBudgetCents: role === 'manager' ? 2500 : 1000,
  };
}

function app({ slug, name, icon, entrySurfaceId = 'home', collections, surfaces, workflows }) {
  return {
    manifestVersion: 1,
    agentisVersion: '1.0.0',
    identity: {
      manifestVersion: 1,
      slug,
      name,
      version: '0.1.0',
      icon,
      entrySurfaceId,
      capabilities: ['demo', 'technical-operator-command'],
      requiredPlugins: [],
    },
    policy: {},
    workflows,
    surfaces,
    collections,
    agents: [],
    capabilities: [],
    requiredPlugins: [],
    dependencies: [],
    migrations: [],
    source: { kind: 'local', id: `demo:${slug}`, author: { displayName: 'Nexseed' } },
  };
}

function collection(name, fields, seed) {
  return { name, schema: { strict: true, fields }, seed };
}

function field(key, type = 'string', required = false, indexed = false, description) {
  return { key, type, required, indexed, ...(description ? { description } : {}) };
}

function surface(name, view, actions = []) {
  return { name, kind: 'page', view, actions, shareable: false };
}

function surfaceRoot(children, design = 'console') {
  return {
    type: 'Stack',
    gap: 16,
    style: { shell: 'full', theme: 'operations', design, appearance: 'dark', density: 'compact' },
    children,
  };
}

function hero(title, subtitle, eyebrow = 'Technical Command Lab') {
  return { type: 'Hero', eyebrow, title, subtitle };
}

function kpis(items) {
  return { type: 'KPIStrip', items };
}

function opsRail() {
  return {
    type: 'Stack',
    gap: 12,
    children: [
      { type: 'OrchestrationPanel', title: 'Workflow Rules', controls: true },
      { type: 'RunMonitor', title: 'Live Runs', limit: 8, controls: true },
      { type: 'AgentFeed', title: 'Agent Trace', limit: 24 },
      { type: 'ApprovalsInbox', title: 'Approval Gates', limit: 8 },
    ],
  };
}

function workflow(title, collectionName, record, withApproval = false) {
  const nodes = [
    node('trigger', 'trigger', 'Manual trigger', 0, 0, { kind: 'trigger', triggerType: 'manual' }),
    node('prepare', 'transform', 'Prepare deterministic demo payload', 260, 0, {
      kind: 'transform',
      expression: `({ ok: true, generatedAt: "${now}", note: "Demo workflow prepared ${escapeForExpression(title)}" })`,
    }),
  ];
  const edges = [{ id: 'e-trigger-prepare', source: 'trigger', target: 'prepare' }];
  if (withApproval) {
    nodes.push(node('approval', 'human_input', 'Operator approval gate', 520, 0, {
      kind: 'human_input',
      prompt: `Approve the demo action for ${title}?`,
      fields: [
        { key: 'approved', label: 'Approved', type: 'boolean', required: true },
        { key: 'note', label: 'Operator note', type: 'textarea' },
      ],
      outputKey: 'approval',
    }));
    edges.push({ id: 'e-prepare-approval', source: 'prepare', target: 'approval' });
    edges.push({ id: 'e-approval-write', source: 'approval', target: 'write' });
  } else {
    edges.push({ id: 'e-prepare-write', source: 'prepare', target: 'write' });
  }
  nodes.push(
    node('write', 'data_mutate', `Write ${collectionName}`, withApproval ? 780 : 520, 0, {
      kind: 'data_mutate',
      collection: collectionName,
      operation: 'insert',
      record,
      outputKey: 'created',
    }),
    node('output', 'return_output', 'Return receipt', withApproval ? 1040 : 780, 0, {
      kind: 'return_output',
      renderAs: 'json',
      title: `${title} receipt`,
    }),
  );
  edges.push({ id: 'e-write-output', source: 'write', target: 'output' });
  return {
    slug: slugify(title),
    title,
    description: `Demo workflow: ${title}`,
    graph: { version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 0.9 } },
  };
}

function node(id, type, title, x, y, config) {
  return { id, type, title, position: { x, y }, config };
}

function commandCenterApp() {
  const collections = [
    collection('missions', [
      field('project', 'string', true, true),
      field('mission', 'string', true),
      field('status', 'string', true, true),
      field('manager', 'string', true, true),
      field('priority', 'string'),
      field('eta', 'date'),
    ], [
      { project: 'Agentis', mission: 'Prepare OSS launch command workspace', status: 'running', manager: 'The Brain', priority: 'P0', eta: '2026-07-10' },
      { project: 'browser-ops-kit', mission: 'Stabilize screenshot harness and docs', status: 'blocked', manager: 'Engineering Manager', priority: 'P1', eta: '2026-07-11' },
      { project: 'personal-brain', mission: 'Package citation-first memory demo', status: 'review', manager: 'Research Manager', priority: 'P1', eta: '2026-07-12' },
    ]),
    collection('managers', [
      field('name', 'string', true, true),
      field('domain', 'string', true),
      field('status', 'string', true, true),
      field('activeRuns', 'number'),
      field('pendingApprovals', 'number'),
      field('budgetUsd', 'number'),
    ], [
      { name: 'Engineering Manager', domain: 'Repo readiness', status: 'running', activeRuns: 3, pendingApprovals: 0, budgetUsd: 25 },
      { name: 'Automation Manager', domain: 'Recurring systems', status: 'live', activeRuns: 2, pendingApprovals: 1, budgetUsd: 12 },
      { name: 'Launch Manager', domain: 'Content and releases', status: 'review', activeRuns: 1, pendingApprovals: 2, budgetUsd: 80 },
      { name: 'Operator Ops Manager', domain: 'People and budget', status: 'live', activeRuns: 1, pendingApprovals: 1, budgetUsd: 300 },
    ]),
    collection('activity', [
      field('at', 'date', true, true),
      field('actor', 'string', true),
      field('event', 'string', true),
      field('tone', 'string'),
    ], [
      { at: '2026-07-07', actor: 'The Brain', event: 'Split launch mission across five managers', tone: 'success' },
      { at: '2026-07-07', actor: 'Budget Specialist', event: 'Queued approval for paid launch experiment', tone: 'warning' },
      { at: '2026-07-07', actor: 'CI Specialist', event: 'Flagged flaky browser screenshot test', tone: 'danger' },
    ]),
  ];
  return app({
    slug: 'command-center',
    name: 'Command Center',
    icon: 'command',
    collections,
    workflows: [
      workflow('Dispatch Launch Mission', 'activity', { at: '2026-07-07', actor: 'The Brain', event: 'Dispatched a new multi-project launch mission', tone: 'success' }),
      workflow('Review Cross-App Approvals', 'activity', { at: '2026-07-07', actor: 'The Brain', event: 'Reviewed pending cross-app approval gates', tone: 'warning' }, true),
    ],
    surfaces: [
      surface('home', surfaceRoot([
        hero('Command Center', 'One operator coordinating managers, specialists, workflows, approvals, and app surfaces across personal technical projects.'),
        kpis([
          { label: 'Managers', value: 5, delta: 'all staffed', tone: 'success', spark: [2, 3, 4, 5, 5] },
          { label: 'Active Missions', value: 7, delta: '3 apps running', tone: 'accent', spark: [1, 3, 4, 6, 7] },
          { label: 'Approval Gates', value: 4, delta: 'operator controlled', tone: 'warning', spark: [0, 1, 3, 2, 4] },
          { label: 'Demo Mode', value: 'deterministic', delta: 'no paid APIs', tone: 'info' },
        ]),
        { type: 'Split', ratio: 1.7, left: {
          type: 'Stack', gap: 12, children: [
            { type: 'Kanban', bind: { collection: 'missions', live: true }, groupBy: 'status', columns: ['running', 'blocked', 'review', 'done'], titleField: 'project', subtitleField: 'mission', badgeField: 'priority' },
            { type: 'Table', bind: { collection: 'managers', live: true }, columns: [
              { key: 'name', label: 'Manager' }, { key: 'domain', label: 'Domain' }, { key: 'status', label: 'Status', format: 'badge' }, { key: 'activeRuns', label: 'Runs', format: 'number' }, { key: 'pendingApprovals', label: 'Approvals', format: 'number' },
            ] },
          ],
        }, right: opsRail() },
      ])),
      surface('activity', surfaceRoot([
        hero('Activity Log', 'Synthetic but realistic operator trace for videos, screenshots, and technical walkthroughs.'),
        { type: 'Timeline', title: 'Workspace Activity', bind: { collection: 'activity', sort: [{ field: 'at', dir: 'desc' }], live: true }, titleField: 'actor', detailField: 'event', atField: 'at' },
      ])),
    ],
  });
}

function repoControlApp() {
  const collections = [
    collection('repos', [
      field('name', 'string', true, true), field('language', 'string'), field('status', 'string', true, true), field('coverage', 'number'), field('openBlockers', 'number'), field('nextAction', 'string'),
    ], [
      { name: 'agentis', language: 'TypeScript', status: 'release-candidate', coverage: 83, openBlockers: 2, nextAction: 'Record 60-second demo' },
      { name: 'browser-ops-kit', language: 'TypeScript', status: 'needs-tests', coverage: 61, openBlockers: 4, nextAction: 'Stabilize screenshot diff harness' },
      { name: 'personal-brain', language: 'Python', status: 'docs-gap', coverage: 48, openBlockers: 3, nextAction: 'Write architecture guide' },
    ]),
    collection('blockers', [
      field('repo', 'string', true, true), field('title', 'string', true), field('severity', 'string', true, true), field('owner', 'string'), field('status', 'string', true, true),
    ], [
      { repo: 'agentis', title: 'Bundle import screenshots missing', severity: 'medium', owner: 'Launch Manager', status: 'triage' },
      { repo: 'browser-ops-kit', title: 'Mobile viewport canvas test flaky', severity: 'high', owner: 'CI Specialist', status: 'fixing' },
      { repo: 'personal-brain', title: 'Citation confidence needs UI copy', severity: 'medium', owner: 'Citation Specialist', status: 'review' },
    ]),
    collection('release_checks', [
      field('repo', 'string', true, true), field('check', 'string', true), field('state', 'string', true, true), field('evidence', 'string'),
    ], [
      { repo: 'agentis', check: 'typecheck', state: 'passed', evidence: 'workspace typecheck green in demo baseline' },
      { repo: 'browser-ops-kit', check: 'visual regression', state: 'failed', evidence: '2 mobile diffs need inspection' },
      { repo: 'personal-brain', check: 'README', state: 'warning', evidence: 'quickstart lacks import example' },
    ]),
  ];
  return app({
    slug: 'repo-control',
    name: 'Repo Control',
    icon: 'git-branch',
    collections,
    workflows: [
      workflow('Nightly Repo Health Scan', 'release_checks', { repo: 'agentis', check: 'nightly demo scan', state: 'passed', evidence: 'mock GitHub and CI endpoints healthy' }),
      workflow('File Release Blocker', 'blockers', { repo: 'agentis', title: 'Demo-generated blocker from workflow run', severity: 'low', owner: 'Engineering Manager', status: 'triage' }),
    ],
    surfaces: [
      surface('home', surfaceRoot([
        hero('Repo Control', 'Engineering manager view for repo readiness, blockers, release checks, and live workflow evidence.', 'Engineering Manager'),
        kpis([
          { label: 'Repos', value: 3, delta: 'tracked', tone: 'accent' },
          { label: 'Release Candidate', value: 1, delta: 'Agentis', tone: 'success' },
          { label: 'Open Blockers', value: 9, delta: '2 high', tone: 'warning' },
          { label: 'Avg Coverage', value: '64%', delta: '+6 planned', tone: 'info' },
        ]),
        { type: 'Split', ratio: 1.8, left: {
          type: 'Stack', gap: 12, children: [
            { type: 'RecordMaster', bind: { collection: 'repos', live: true }, titleField: 'name', subtitleField: 'nextAction', statusField: 'status', searchFields: ['name', 'language', 'nextAction'], sections: [{ title: 'Release State', fields: ['language', 'status', 'coverage', 'openBlockers', 'nextAction'] }], related: [{ collection: 'blockers', foreignKey: 'repo', title: 'Blockers', titleField: 'title' }] },
            { type: 'Kanban', bind: { collection: 'blockers', live: true }, groupBy: 'status', columns: ['triage', 'fixing', 'review', 'done'], titleField: 'title', subtitleField: 'repo', badgeField: 'severity' },
          ],
        }, right: opsRail() },
      ])),
    ],
  });
}

function automationLabApp() {
  const collections = [
    collection('automations', [
      field('name', 'string', true, true), field('trigger', 'string'), field('status', 'string', true, true), field('schedule', 'string'), field('owner', 'string'),
    ], [
      { name: 'Nightly repo health scan', trigger: 'cron', status: 'armed', schedule: '0 3 * * *', owner: 'Scheduler Specialist' },
      { name: 'New issue triage', trigger: 'webhook', status: 'listening', schedule: 'github.issue.opened', owner: 'Automation Manager' },
      { name: 'Launch checklist validator', trigger: 'manual', status: 'review', schedule: 'before publish', owner: 'The Brain' },
    ]),
    collection('integrations', [
      field('service', 'string', true, true), field('mode', 'string'), field('status', 'string', true, true), field('lastEvent', 'string'),
    ], [
      { service: 'Mock GitHub', mode: 'local-http', status: 'healthy', lastEvent: '/github/issues returned 3 items' },
      { service: 'Mock Email', mode: 'local-http', status: 'healthy', lastEvent: 'outbox accepted launch digest' },
      { service: 'Mock Ads', mode: 'approval-gated', status: 'needs-approval', lastEvent: 'budget check requires operator approval' },
    ]),
    collection('run_events', [
      field('workflow', 'string', true, true), field('status', 'string', true, true), field('detail', 'string'), field('at', 'date', true),
    ], [
      { workflow: 'Nightly repo health scan', status: 'completed', detail: '3 repos scanned with mock service', at: '2026-07-07' },
      { workflow: 'New issue triage', status: 'waiting', detail: 'approval required before creating external issue', at: '2026-07-07' },
    ]),
  ];
  return app({
    slug: 'automation-lab',
    name: 'Automation Lab',
    icon: 'workflow',
    collections,
    workflows: [
      workflow('Arm Nightly Repo Scan', 'run_events', { workflow: 'Nightly repo health scan', status: 'armed', detail: 'App-level schedule patched by seed script', at: '2026-07-07' }),
      workflow('Mock Webhook Triage', 'run_events', { workflow: 'New issue triage', status: 'waiting', detail: 'Operator approval needed before external mutation', at: '2026-07-07' }, true),
    ],
    surfaces: [
      surface('home', surfaceRoot([
        hero('Automation Lab', 'Cron, webhook, retry, and integration control without real third-party credentials.', 'Automation Manager'),
        { type: 'Split', ratio: 1.7, left: {
          type: 'Stack', gap: 12, children: [
            { type: 'Table', bind: { collection: 'automations', live: true }, columns: [{ key: 'name' }, { key: 'trigger' }, { key: 'status', format: 'badge' }, { key: 'schedule' }, { key: 'owner' }] },
            { type: 'StatusBoard', title: 'Mock Integrations', items: [
              { label: 'GitHub', status: 'healthy', detail: 'local mock' },
              { label: 'Email', status: 'healthy', detail: 'outbox only' },
              { label: 'Ads', status: 'approval', detail: 'spend is simulated' },
            ] },
            { type: 'Timeline', title: 'Run Events', bind: { collection: 'run_events', sort: [{ field: 'at', dir: 'desc' }], live: true }, titleField: 'workflow', detailField: 'detail', atField: 'at' },
          ],
        }, right: opsRail() },
      ])),
    ],
  });
}

function researchDeskApp() {
  const collections = [
    collection('sources', [
      field('title', 'string', true, true), field('kind', 'string'), field('status', 'string', true, true), field('url', 'string'), field('trust', 'number'),
    ], [
      { title: 'Agentis README', kind: 'local-doc', status: 'indexed', url: 'repo://README.md', trust: 0.95 },
      { title: 'Workflow reliability notes', kind: 'local-doc', status: 'indexed', url: 'repo://docs/WORKFLOW-RELIABILITY-10X.md', trust: 0.91 },
      { title: 'Launch video context', kind: 'local-doc', status: 'queued', url: 'repo://docs/1.1.1-VIDEOS-CONTEXT.md', trust: 0.78 },
    ]),
    collection('claims', [
      field('claim', 'string', true), field('status', 'string', true, true), field('source', 'string'), field('confidence', 'number'), field('owner', 'string'),
    ], [
      { claim: 'Agentis is local-first and self-hostable.', status: 'supported', source: 'Agentis README', confidence: 0.95, owner: 'Citation Specialist' },
      { claim: 'App surfaces can display live workflow operations.', status: 'supported', source: 'APP INTERFACE 10X', confidence: 0.9, owner: 'Research Manager' },
      { claim: 'Workspace bundles can carry multiple apps.', status: 'supported', source: 'WORKSPACE BUNDLE MASTERPLAN', confidence: 0.92, owner: 'The Brain' },
    ]),
    collection('notes', [
      field('topic', 'string', true, true), field('summary', 'string'), field('status', 'string', true, true), field('updatedAt', 'date'),
    ], [
      { topic: 'Technical audience positioning', summary: 'Lead with local agent fleet, workflows, approvals, and auditability.', status: 'ready', updatedAt: '2026-07-07' },
      { topic: 'Demo safety', summary: 'Use mock services and deterministic seed data for repeatable videos.', status: 'ready', updatedAt: '2026-07-07' },
    ]),
  ];
  return app({
    slug: 'research-desk',
    name: 'Research Desk',
    icon: 'search',
    collections,
    workflows: [
      workflow('Ingest Launch Research', 'notes', { topic: 'Workflow-generated note', summary: 'A deterministic research note was added by a demo workflow.', status: 'draft', updatedAt: '2026-07-07' }),
      workflow('Review Claim Evidence', 'claims', { claim: 'Demo workflow claims must include a source.', status: 'review', source: 'Technical Command Lab', confidence: 0.7, owner: 'Citation Specialist' }, true),
    ],
    surfaces: [
      surface('home', surfaceRoot([
        hero('Research Desk', 'Citation-first research for launch positioning, docs, and claims technical users can inspect.', 'Research Manager'),
        { type: 'Split', ratio: 1.75, left: {
          type: 'Stack', gap: 12, children: [
            { type: 'Table', bind: { collection: 'sources', live: true }, columns: [{ key: 'title' }, { key: 'kind' }, { key: 'status', format: 'badge' }, { key: 'trust', format: 'number' }] },
            { type: 'RecordMaster', bind: { collection: 'claims', live: true }, titleField: 'claim', subtitleField: 'source', statusField: 'status', searchFields: ['claim', 'source', 'owner'], sections: [{ title: 'Evidence', fields: ['status', 'source', 'confidence', 'owner'] }] },
          ],
        }, right: opsRail() },
      ])),
    ],
  });
}

function launchStudioApp() {
  const collections = [
    collection('assets', [
      field('asset', 'string', true, true), field('kind', 'string'), field('status', 'string', true, true), field('owner', 'string'), field('due', 'date'),
    ], [
      { asset: '60-second product video', kind: 'video-script', status: 'drafting', owner: 'Launch Manager', due: '2026-07-08' },
      { asset: 'Command Center screenshot set', kind: 'screenshots', status: 'ready', owner: 'Screenshot Specialist', due: '2026-07-08' },
      { asset: 'OSS README launch section', kind: 'docs', status: 'review', owner: 'Docs Specialist', due: '2026-07-09' },
    ]),
    collection('publish_queue', [
      field('channel', 'string', true, true), field('item', 'string', true), field('status', 'string', true, true), field('approval', 'string'), field('scheduledFor', 'date'),
    ], [
      { channel: 'GitHub Releases', item: 'Agentis Technical Command Lab bundle', status: 'blocked', approval: 'operator', scheduledFor: '2026-07-10' },
      { channel: 'Website', item: '60-second demo video', status: 'review', approval: 'operator', scheduledFor: '2026-07-10' },
      { channel: 'Social', item: 'Technical launch thread', status: 'draft', approval: 'operator', scheduledFor: '2026-07-11' },
    ]),
    collection('calendar', [
      field('label', 'string', true), field('date', 'date', true, true), field('lane', 'string'), field('status', 'string', true, true),
    ], [
      { label: 'Record demo walkthrough', date: '2026-07-08', lane: 'Video', status: 'planned' },
      { label: 'Publish OSS bundle', date: '2026-07-10', lane: 'Release', status: 'approval' },
      { label: 'Collect first feedback', date: '2026-07-12', lane: 'Feedback', status: 'planned' },
    ]),
  ];
  return app({
    slug: 'launch-studio',
    name: 'Launch Studio',
    icon: 'rocket',
    collections,
    workflows: [
      workflow('Generate Launch Asset Checklist', 'assets', { asset: 'Workflow-generated screenshot checklist', kind: 'screenshots', status: 'drafting', owner: 'Screenshot Specialist', due: '2026-07-08' }),
      workflow('Approve Publish Queue', 'publish_queue', { channel: 'Website', item: 'Workflow-generated launch item', status: 'blocked', approval: 'operator', scheduledFor: '2026-07-10' }, true),
    ],
    surfaces: [
      surface('home', surfaceRoot([
        hero('Launch Studio', 'Release notes, video scripts, screenshots, and publish gates for technical personal projects.', 'Launch Manager'),
        { type: 'Split', ratio: 1.75, left: {
          type: 'Stack', gap: 12, children: [
            { type: 'Kanban', bind: { collection: 'assets', live: true }, groupBy: 'status', columns: ['drafting', 'review', 'ready', 'published'], titleField: 'asset', subtitleField: 'kind', badgeField: 'owner' },
            { type: 'Roadmap', title: 'Launch Calendar', bind: { collection: 'calendar', live: true }, labelField: 'label', startField: 'date', laneField: 'lane', statusField: 'status', scale: 'weeks' },
            { type: 'Table', bind: { collection: 'publish_queue', live: true }, columns: [{ key: 'channel' }, { key: 'item' }, { key: 'status', format: 'badge' }, { key: 'approval' }, { key: 'scheduledFor', format: 'date' }] },
          ],
        }, right: opsRail() },
      ])),
    ],
  });
}

function operatorDeskApp() {
  const collections = [
    collection('contacts', [
      field('name', 'string', true, true), field('relation', 'string'), field('status', 'string', true, true), field('nextStep', 'string'), field('lastContactAt', 'date'),
    ], [
      { name: 'First OSS maintainer cohort', relation: 'community', status: 'to-notify', nextStep: 'Send demo bundle after screenshots', lastContactAt: '2026-07-06' },
      { name: 'Design partner list', relation: 'users', status: 'waiting', nextStep: 'Ask for workflow import feedback', lastContactAt: '2026-07-05' },
      { name: 'Launch reviewer', relation: 'advisor', status: 'scheduled', nextStep: 'Review 5-minute technical video', lastContactAt: '2026-07-07' },
    ]),
    collection('decisions', [
      field('decision', 'string', true), field('status', 'string', true, true), field('owner', 'string'), field('rationale', 'string'), field('decidedAt', 'date'),
    ], [
      { decision: 'First public demo targets technical users', status: 'accepted', owner: 'operator', rationale: 'Demonstrate Agentis as a local technical command workspace.', decidedAt: '2026-07-07' },
      { decision: 'Use mock integrations for OSS demo', status: 'accepted', owner: 'operator', rationale: 'Safe, deterministic, and screen-recordable.', decidedAt: '2026-07-07' },
    ]),
    collection('budget_items', [
      field('item', 'string', true), field('amountUsd', 'number', true), field('status', 'string', true, true), field('reason', 'string'),
    ], [
      { item: 'Launch ads experiment', amountUsd: 300, status: 'approval', reason: 'Operator requires approval before paid spend.' },
      { item: 'Video captions tool', amountUsd: 29, status: 'approved', reason: 'Below threshold, useful for launch accessibility.' },
    ]),
  ];
  return app({
    slug: 'operator-desk',
    name: 'Operator Desk',
    icon: 'inbox',
    collections,
    workflows: [
      workflow('Queue Follow Up', 'contacts', { name: 'Workflow-generated contact', relation: 'community', status: 'to-notify', nextStep: 'Review demo and send feedback', lastContactAt: '2026-07-07' }),
      workflow('Approve Budget Item', 'budget_items', { item: 'Workflow-generated spend request', amountUsd: 125, status: 'approval', reason: 'Demo workflow budget approval gate' }, true),
    ],
    surfaces: [
      surface('home', surfaceRoot([
        hero('Operator Desk', 'Personal project people, follow-ups, budget gates, and durable decisions alongside technical work.', 'Personal Ops Manager'),
        { type: 'Split', ratio: 1.8, left: {
          type: 'Stack', gap: 12, children: [
            { type: 'RecordMaster', bind: { collection: 'contacts', live: true }, titleField: 'name', subtitleField: 'nextStep', statusField: 'status', searchFields: ['name', 'relation', 'nextStep'], sections: [{ title: 'Follow-up', fields: ['relation', 'status', 'nextStep', 'lastContactAt'] }] },
            { type: 'Table', bind: { collection: 'budget_items', live: true }, columns: [{ key: 'item' }, { key: 'amountUsd', format: 'number' }, { key: 'status', format: 'badge' }, { key: 'reason' }] },
            { type: 'Timeline', title: 'Decisions', bind: { collection: 'decisions', sort: [{ field: 'decidedAt', dir: 'desc' }], live: true }, titleField: 'decision', detailField: 'rationale', atField: 'decidedAt' },
          ],
        }, right: opsRail() },
      ])),
    ],
  });
}

function mockIntegrations() {
  return [
    {
      name: 'Demo Mock GitHub',
      slug: 'demo-mock-github',
      service: 'demo_github',
      version: '0.1.0',
      category: 'developer-tools',
      description: 'Local mock integration for repo and issue data.',
      operationSpecs: [{ name: 'list_issues', method: 'GET', urlTemplate: 'http://127.0.0.1:4747/github/issues', responseMode: 'json' }],
      auth: { type: 'none' },
      credentialSchema: {},
      nodeConfig: { kind: 'integration', service: 'demo_github', operation: 'list_issues' },
      runtime: 'manifest_only',
    },
    {
      name: 'Demo Mock Email',
      slug: 'demo-mock-email',
      service: 'demo_email',
      version: '0.1.0',
      category: 'communication',
      description: 'Local outbox-only email integration for safe launch demos.',
      operationSpecs: [{ name: 'queue_email', method: 'POST', urlTemplate: 'http://127.0.0.1:4747/email/outbox', responseMode: 'json' }],
      auth: { type: 'none' },
      credentialSchema: {},
      nodeConfig: { kind: 'integration', service: 'demo_email', operation: 'queue_email' },
      runtime: 'manifest_only',
    },
  ];
}

function knowledgeSeeds() {
  return [
    {
      title: 'Demo Mission Brief',
      tags: ['demo', 'mission', 'technical-operator'],
      metadata: { source: 'technical-command-lab' },
      content: [
        '# Mission',
        'Prepare Agentis, browser-ops-kit, and personal-brain for public launch in one week.',
        '',
        'Constraints: use mock services, ask before publishing or spending, keep every action observable, and preserve exact records in app collections.',
      ].join('\n'),
    },
    {
      title: 'Operator Policy',
      tags: ['approval', 'policy'],
      metadata: { source: 'technical-command-lab' },
      content: 'Approval is required before external publishing, paid spend over 100 USD, deleting records, or sending outreach to more than five contacts.',
    },
    {
      title: 'Technical Demo Narrative',
      tags: ['video', 'launch'],
      metadata: { source: 'technical-command-lab' },
      content: 'The first demo should show Agentis as a local technical command workspace: managers, specialists, app surfaces, workflows, live runs, approval gates, knowledge, and mock integrations.',
    },
  ];
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';
}

function escapeForExpression(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
