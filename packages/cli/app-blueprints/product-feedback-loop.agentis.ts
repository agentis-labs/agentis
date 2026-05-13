import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'product-feedback-loop',
  name: 'Product Feedback Loop',
  category: 'product',
  replaces: 'Manual feedback tagging, theme clustering, and roadmap brief drafting',
  costSavedPerMonth: '$900/mo plus PM synthesis time',
  description: 'Clusters user feedback, scores product themes, drafts specs, and routes roadmap candidates for review.',
  capabilityTags: ['product', 'feedback-analysis', 'roadmap'],
  instructions: 'Operate like a product manager who cares about customer evidence and strategic fit.',
  prompt: 'Analyze feedback payload and retrieved customer/product context. Return theme, affected segment, urgency, evidence, strategic fit, and recommended product action.',
  datasets: [
    { key: 'FEEDBACK_ARCHIVE', label: 'Feedback Archive', description: 'Support tickets, NPS comments, interviews, sales notes, and feature requests.', acceptedFormats: ['csv', 'zendesk-export', 'intercom-export', 'jsonl'], requiredFields: ['customer', 'feedback'] },
    { key: 'ROADMAP_CONTEXT', label: 'Roadmap and Strategy Context', description: 'Product strategy, current roadmap, feature ownership, and prioritization principles.', acceptedFormats: ['markdown-zip', 'pdf'], chunkingStrategy: 'per-document' },
  ],
  credentials: [{ key: 'TRACKER', service: 'linear', label: 'Issue tracker', oauthFlow: true, required: false }],
  seedTitle: 'Feedback Prioritization Rules',
  seedContent: 'Strong product signals repeat across valuable segments, tie to active strategy, reduce measurable pain, and have clear ownership. Do not over-weight one loud customer without segment context.',
  rubricContext: 'feedback-theme-quality',
  evaluatorCriteria: 'Pass only when the theme includes evidence count, customer segment, urgency, strategic fit, and recommended action.',
});