import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'engineering-copilot',
  name: 'Engineering Copilot',
  category: 'engineering',
  replaces: 'First-pass PR triage and architecture risk review',
  costSavedPerMonth: '$1,500/mo in senior review time',
  description: 'Reviews code changes, scores risk, surfaces missing tests, and routes high-risk PRs for human review.',
  capabilityTags: ['code-review', 'security', 'architecture'],
  instructions: 'Operate like a pragmatic staff engineer. Be specific, evidence-based, and conservative on security and data-loss risks.',
  prompt: 'Review the PR or code-change payload against retrieved codebase context. Return risk score, specific findings, missing tests, architectural concerns, and routing recommendation.',
  datasets: [
    { key: 'CODEBASE', label: 'Codebase Snapshot', description: 'Repository files, module boundaries, public APIs, and ownership notes.', acceptedFormats: ['github-repo', 'markdown-zip'], chunkingStrategy: 'per-function', requiredFields: ['path'] },
    { key: 'PR_HISTORY', label: 'PR and Incident History', description: 'Past PRs, review comments, defects, incidents, and postmortem links.', acceptedFormats: ['csv', 'jsonl'], chunkingStrategy: 'per-row', optional: true },
  ],
  credentials: [{ key: 'GITHUB', service: 'github', label: 'GitHub repository access', oauthFlow: true }],
  seedTitle: 'Engineering Review Policy',
  seedContent: 'Block changes that alter auth, billing, migrations, secrets, permission checks, or data deletion without tests and explicit reviewer ownership. Prefer actionable findings with file-specific evidence.',
  rubricContext: 'engineering-review-quality',
  evaluatorCriteria: 'Pass only when findings are actionable, grounded in the submitted change, and include test or ownership recommendations.',
});