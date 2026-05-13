import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'content-machine',
  name: 'Content Machine',
  category: 'marketing',
  replaces: 'Manual topic research, draft QA, and content calendar upkeep',
  costSavedPerMonth: '$700/mo plus editorial coordination time',
  description: 'Researches content opportunities, drafts briefs, evaluates quality, and prepares human-approved publishing plans.',
  capabilityTags: ['content', 'seo', 'editorial'],
  instructions: 'Operate like an editor who protects brand voice and factual precision.',
  prompt: 'Use topic payload and retrieved brand context to produce a content brief with angle, audience, sources needed, outline, quality risks, and publishing recommendation.',
  datasets: [
    { key: 'BRAND_GUIDELINES', label: 'Brand and Voice Guidelines', description: 'Messaging, tone, forbidden claims, examples, and style rules.', acceptedFormats: ['markdown-zip', 'pdf'], chunkingStrategy: 'per-document' },
    { key: 'CONTENT_HISTORY', label: 'Content Performance History', description: 'Published content, search terms, traffic, conversion, and engagement metrics.', acceptedFormats: ['csv', 'json'], requiredFields: ['title', 'metric', 'value'] },
  ],
  credentials: [{ key: 'CMS', service: 'cms', label: 'CMS publishing credential', required: false }],
  seedTitle: 'Editorial Quality Bar',
  seedContent: 'Strong content has a distinct point of view, specific audience, credible evidence, and a clear job for the reader. Reject vague thought leadership without proof or useful specificity.',
  rubricContext: 'content-brief-quality',
  evaluatorCriteria: 'Pass only when the brief names audience, angle, evidence plan, outline, and brand-safety risks.',
});