import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'customer-success-autopilot',
  name: 'Customer Success Autopilot',
  category: 'customer-success',
  replaces: 'Manual account health review and churn triage',
  costSavedPerMonth: '$900/mo plus CSM prep time',
  description: 'Synthesizes account health, identifies churn risk, and drafts intervention plans for CSM review.',
  capabilityTags: ['customer-success', 'risk-analysis', 'account-management'],
  instructions: 'Operate like a thoughtful CSM leader. Treat customer risk as a hypothesis to validate, not a label.',
  prompt: 'Analyze account payload and retrieved customer history. Return health score, risk drivers, expansion signals, recommended intervention, and owner handoff notes.',
  datasets: [
    { key: 'SUPPORT_HISTORY', label: 'Support Ticket History', description: 'Tickets, sentiment, severity, resolution time, and escalation history.', acceptedFormats: ['csv', 'zendesk-export', 'intercom-export'], requiredFields: ['account', 'subject', 'status'] },
    { key: 'ACCOUNT_USAGE', label: 'Account Usage Metrics', description: 'Product usage, seats, feature adoption, NPS, billing, and renewal date.', acceptedFormats: ['csv', 'json'], requiredFields: ['account', 'metric', 'value'] },
  ],
  credentials: [{ key: 'CRM', service: 'salesforce', label: 'CRM account records', oauthFlow: true, required: false }],
  seedTitle: 'Customer Health Heuristics',
  seedContent: 'Risk increases when usage drops, support severity rises, executive sponsor changes, renewal nears, or promised outcomes are unclear. Healthy accounts show stable adoption, clear business outcomes, and active champions.',
  rubricContext: 'customer-health-quality',
  evaluatorCriteria: 'Pass only when the brief includes evidence, separates risk from confidence, and proposes a practical intervention.',
});