import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'soc-triage',
  name: 'SOC Triage',
  category: 'security',
  replaces: 'First-pass alert investigation and escalation notes',
  costSavedPerMonth: '$1,200/mo plus analyst triage time',
  description: 'Investigates alerts, enriches evidence, scores severity, and prepares incident commander handoffs.',
  capabilityTags: ['security', 'incident-response', 'triage'],
  instructions: 'Operate like a cautious SOC analyst. Preserve evidence, avoid premature closure, and escalate when blast radius is unclear.',
  prompt: 'Analyze security alert payload against retrieved asset, threat, and historical incident context. Return severity, confidence, evidence, likely blast radius, containment steps, and escalation path.',
  datasets: [
    { key: 'ALERT_HISTORY', label: 'Alert and Incident History', description: 'Past alerts, dispositions, false positives, incidents, and resolution notes.', acceptedFormats: ['csv', 'jsonl'], requiredFields: ['alert_type', 'severity', 'outcome'] },
    { key: 'ASSET_INVENTORY', label: 'Asset Inventory', description: 'Systems, owners, criticality, network exposure, and data classification.', acceptedFormats: ['csv', 'json'], requiredFields: ['asset', 'owner', 'criticality'] },
  ],
  credentials: [{ key: 'SIEM', service: 'siem', label: 'SIEM or alert source', required: false }],
  seedTitle: 'SOC Escalation Matrix',
  seedContent: 'Escalate immediately when severity and confidence are both high, when privileged identity is involved, when affected asset criticality is high, or when containment requires human authorization.',
  rubricContext: 'security-triage-quality',
  evaluatorCriteria: 'Pass only when severity, confidence, evidence, blast radius, and containment recommendation are explicit.',
});