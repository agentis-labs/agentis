import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'executive-intelligence',
  name: 'Executive Intelligence',
  category: 'operations',
  replaces: 'Morning executive brief preparation across teams and metrics',
  costSavedPerMonth: '$1,000/mo plus leadership prep time',
  description: 'Synthesizes strategic signals, team updates, metrics, calendar context, and risks into a daily executive brief.',
  capabilityTags: ['executive-reporting', 'strategy', 'synthesis'],
  instructions: 'Operate like a chief of staff. Be brief, prioritized, and clear about what needs attention today.',
  prompt: 'Analyze daily signal payload against retrieved operating context. Return top priorities, risks, positive trends, decisions needed, and suggested follow-up questions.',
  datasets: [
    { key: 'OPERATING_CONTEXT', label: 'Operating Context', description: 'Company goals, strategic priorities, OKRs, org notes, and planning docs.', acceptedFormats: ['markdown-zip', 'pdf'], chunkingStrategy: 'per-document' },
    { key: 'TEAM_UPDATES', label: 'Team Updates and Standups', description: 'Slack summaries, standups, project status, blockers, and incidents.', acceptedFormats: ['csv', 'jsonl', 'markdown-zip'], chunkingStrategy: 'per-document', optional: true },
  ],
  credentials: [{ key: 'CALENDAR', service: 'calendar', label: 'Executive calendar', oauthFlow: true, required: false }],
  seedTitle: 'Executive Brief Rules',
  seedContent: 'An executive brief should surface what changed, why it matters, what decision is needed, and who owns the next step. Keep it short enough to read before the first meeting.',
  rubricContext: 'executive-brief-quality',
  evaluatorCriteria: 'Pass only when the brief is prioritized, concise, evidence-backed, and includes owners or next questions.',
});