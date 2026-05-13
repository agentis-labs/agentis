import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'legal-compliance-monitor',
  name: 'Legal Compliance Monitor',
  category: 'legal',
  replaces: 'Manual contract risk triage and policy drift monitoring',
  costSavedPerMonth: '$1,400/mo plus legal review time',
  description: 'Reviews contract or policy changes, identifies deviations, scores risk, and prepares legal handoffs.',
  capabilityTags: ['legal', 'compliance', 'risk-analysis'],
  instructions: 'Operate like a legal ops analyst. Highlight risk and cite policy context, but leave final legal judgment to a human.',
  prompt: 'Analyze contract or policy payload against retrieved playbook context. Return deviations, risk level, affected obligations, recommended redlines or reviewer, and confidence.',
  datasets: [
    { key: 'CONTRACT_LIBRARY', label: 'Contract Library', description: 'Executed contracts, clause variants, negotiated positions, and outcomes.', acceptedFormats: ['pdf', 'markdown-zip', 'csv'], chunkingStrategy: 'per-document' },
    { key: 'LEGAL_PLAYBOOK', label: 'Legal Playbook', description: 'Approved positions, unacceptable deviations, jurisdiction notes, and escalation rules.', acceptedFormats: ['markdown-zip', 'pdf'], chunkingStrategy: 'per-document' },
  ],
  credentials: [{ key: 'DOC_STORE', service: 'drive', label: 'Document source', oauthFlow: true, required: false }],
  seedTitle: 'Contract Risk Heuristics',
  seedContent: 'Escalate non-standard liability, indemnity, data processing, termination, payment, IP ownership, and audit clauses. Compare deviations to playbook positions and note jurisdiction-specific uncertainty.',
  rubricContext: 'legal-risk-quality',
  evaluatorCriteria: 'Pass only when deviations, policy basis, risk level, confidence, and reviewer recommendation are explicit.',
});