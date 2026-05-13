import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'competitive-intel-os',
  name: 'Competitive Intel OS',
  category: 'strategy',
  replaces: 'Manual competitor monitoring and battlecard updates',
  costSavedPerMonth: '$500/mo plus analyst review time',
  description: 'Monitors competitor signals, scores strategic significance, and produces battlecard-ready briefs.',
  capabilityTags: ['research', 'strategy', 'competitive-intelligence'],
  instructions: 'Operate like a sharp market intelligence analyst. Separate noise from strategic signal.',
  prompt: 'Analyze the competitor signal payload against retrieved positioning context. Return significance score, confidence, likely impact, recommended response, and whether a human should review it.',
  datasets: [
    { key: 'COMPETITOR_CORPUS', label: 'Competitor Corpus', description: 'Pricing pages, changelogs, positioning docs, reviews, press releases, and battlecards.', acceptedFormats: ['csv', 'url-list', 'markdown-zip', 'pdf'], chunkingStrategy: 'per-document' },
    { key: 'POSITIONING_LIBRARY', label: 'Positioning Library', description: 'Your messaging, category narrative, objection handling, and approved claims.', acceptedFormats: ['markdown-zip', 'pdf', 'json'], chunkingStrategy: 'per-document' },
  ],
  credentials: [{ key: 'SLACK', service: 'slack', label: 'Slack alert channel', oauthFlow: true, required: false }],
  seedTitle: 'Competitive Signal Scoring',
  seedContent: 'High-significance signals change buyer perception, pricing pressure, category framing, procurement risk, or roadmap expectations. Low-significance signals are cosmetic copy changes or isolated social posts without evidence.',
  rubricContext: 'competitive-signal-quality',
  evaluatorCriteria: 'Pass only when the brief distinguishes evidence from interpretation and names a concrete GTM or product implication.',
});