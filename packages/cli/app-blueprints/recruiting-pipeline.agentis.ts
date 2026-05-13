import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'recruiting-pipeline',
  name: 'Recruiting Pipeline',
  category: 'people',
  replaces: 'Manual resume triage and candidate brief writing',
  costSavedPerMonth: '$800/mo plus recruiter screening time',
  description: 'Screens applicants against role criteria, researches qualified candidates, and drafts structured hiring briefs.',
  capabilityTags: ['recruiting', 'screening', 'candidate-research'],
  instructions: 'Operate like a fair, structured recruiter. Focus on evidence from role criteria and avoid unsupported assumptions.',
  prompt: 'Evaluate candidate payload against retrieved hiring criteria and past feedback. Return match score, strengths, gaps, evidence, interview focus areas, and routing recommendation.',
  datasets: [
    { key: 'ROLE_CRITERIA', label: 'Role Criteria and Hiring Rubrics', description: 'Job requirements, competency rubric, interview loop, and leveling guidance.', acceptedFormats: ['markdown-zip', 'pdf'], chunkingStrategy: 'per-document' },
    { key: 'INTERVIEW_FEEDBACK', label: 'Interview Feedback Archive', description: 'Historical structured feedback and hiring outcomes for calibration.', acceptedFormats: ['csv', 'jsonl'], targetStore: 'evaluator_examples', requiredFields: ['role', 'signal', 'outcome'], optional: true },
  ],
  credentials: [{ key: 'ATS', service: 'greenhouse', label: 'Applicant tracking system', oauthFlow: true, required: false }],
  seedTitle: 'Structured Screening Rules',
  seedContent: 'Screen against explicit role criteria. Escalate ambiguous but promising evidence for human review. Do not infer protected characteristics or use proxies unrelated to job requirements.',
  rubricContext: 'candidate-screen-quality',
  evaluatorCriteria: 'Pass only when the brief maps evidence to criteria, states uncertainty, and avoids unsupported or irrelevant judgments.',
});