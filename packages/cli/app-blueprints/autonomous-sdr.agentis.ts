import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'autonomous-sdr',
  name: 'Autonomous SDR',
  category: 'sales',
  replaces: 'Apollo + Outreach coordination work',
  costSavedPerMonth: '$200/mo plus SDR research time',
  description: 'Researches leads, scores fit, drafts personalized outreach, and escalates high-value replies.',
  capabilityTags: ['sales', 'research', 'outreach'],
  instructions: 'Operate like a senior SDR who values relevance, timing, and concise evidence over volume.',
  prompt: 'Use the incoming lead payload and retrieved account context to decide whether to contact the lead. Return a concise decision brief with ICP fit, timing signal, suggested email angle, and next step.',
  datasets: [
    { key: 'CRM_HISTORY', label: 'CRM Contact and Deal History', description: 'Contacts, companies, deals, notes, win/loss reasons, and lifecycle stages.', acceptedFormats: ['csv', 'hubspot-export', 'salesforce-export'], requiredFields: ['company', 'contact', 'stage'], exportInstructions: 'Export contacts, companies, deals, and notes with all properties.' },
    { key: 'EMAIL_ARCHIVE', label: 'Approved Email Archive', description: 'Outbound emails and replies used to learn tone, framing, and successful objections.', acceptedFormats: ['csv', 'jsonl', 'markdown-zip'], targetStore: 'memory', chunkingStrategy: 'per-document', optional: true },
    { key: 'SDR_EVAL_EXAMPLES', label: 'Outreach Evaluation Examples', description: 'Examples of emails that should pass or fail quality review.', acceptedFormats: ['csv', 'json'], targetStore: 'evaluator_examples', requiredFields: ['input', 'expectedScore'], optional: true },
  ],
  credentials: [
    { key: 'CRM', service: 'hubspot', label: 'CRM API or export source', oauthFlow: true },
    { key: 'EMAIL', service: 'gmail', label: 'Outbound email account', oauthFlow: true },
  ],
  seedTitle: 'SDR Decision Heuristics',
  seedContent: 'Prioritize accounts with a recent funding, hiring, compliance, migration, or expansion trigger. Personalization must reference a concrete account-specific signal and connect it to a plausible operational pain.',
  rubricContext: 'sdr-outreach-quality',
  evaluatorCriteria: 'Pass only when the brief includes a clear ICP rationale, a sourced timing signal, a specific outreach angle, and a next action.',
});