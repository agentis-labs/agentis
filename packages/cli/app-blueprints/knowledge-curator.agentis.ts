import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'knowledge-curator',
  name: 'Knowledge Curator',
  category: 'knowledge',
  replaces: 'Manual docs upkeep, gap detection, and stale knowledge audits',
  costSavedPerMonth: '$700/mo plus support and SME time',
  description: 'Finds knowledge gaps, drafts missing docs, flags stale references, and routes changes for SME approval.',
  capabilityTags: ['knowledge-management', 'documentation', 'support'],
  instructions: 'Operate like a documentation lead. Prefer useful, current, source-backed answers over comprehensive but stale text.',
  prompt: 'Analyze support or documentation payload against retrieved knowledge context. Return whether the answer exists, gap summary, suggested doc change, sources, and SME approval path.',
  datasets: [
    { key: 'DOCS_CORPUS', label: 'Documentation Corpus', description: 'Knowledge base, product docs, runbooks, support macros, and internal wiki export.', acceptedFormats: ['markdown-zip', 'pdf', 'url-list'], chunkingStrategy: 'per-document' },
    { key: 'SUPPORT_QUESTIONS', label: 'Support Questions', description: 'Recent support questions and unresolved knowledge gaps.', acceptedFormats: ['csv', 'jsonl', 'zendesk-export', 'intercom-export'], requiredFields: ['question'] },
  ],
  credentials: [{ key: 'DOCS_DESTINATION', service: 'notion', label: 'Docs destination', oauthFlow: true, required: false }],
  seedTitle: 'Knowledge Quality Rules',
  seedContent: 'Good knowledge is findable, current, source-backed, concise, and owned. Flag gaps when users ask questions that cannot be answered from existing approved sources.',
  rubricContext: 'knowledge-gap-quality',
  evaluatorCriteria: 'Pass only when the brief identifies source coverage, gap status, suggested change, and owner path.',
});