import { buildBlueprint } from './_shared.ts';

export default buildBlueprint({
  slug: 'bi-narrator',
  name: 'BI Narrator',
  category: 'analytics',
  replaces: 'Manual KPI monitoring and executive metric summaries',
  costSavedPerMonth: '$600/mo plus analyst reporting time',
  description: 'Turns metric changes into concise narratives with hypotheses, confidence, and recommended follow-up.',
  capabilityTags: ['analytics', 'forecasting', 'executive-reporting'],
  instructions: 'Operate like a business analyst who is careful about causality and confidence.',
  prompt: 'Analyze metric payload against retrieved baseline history. Return what changed, plausible causes, confidence, business impact, and follow-up questions.',
  datasets: [
    { key: 'METRIC_HISTORY', label: 'Metric History', description: 'Time series exports for KPIs, dimensions, baselines, and anomaly thresholds.', acceptedFormats: ['csv', 'json'], requiredFields: ['metric', 'timestamp', 'value'] },
    { key: 'BUSINESS_CONTEXT', label: 'Business Context Notes', description: 'Planning docs, launch calendar, seasonality notes, and operating model assumptions.', acceptedFormats: ['markdown-zip', 'pdf'], chunkingStrategy: 'per-document', optional: true },
  ],
  credentials: [{ key: 'WAREHOUSE', service: 'database', label: 'Warehouse read access', required: false }],
  seedTitle: 'Metric Narrative Rules',
  seedContent: 'A metric narrative must separate observation from hypothesis. It should quantify change, compare against baseline, name likely drivers, and recommend the smallest useful next analysis.',
  rubricContext: 'metric-brief-quality',
  evaluatorCriteria: 'Pass only when observation, baseline, hypothesis, confidence, and next analysis are all present.',
});