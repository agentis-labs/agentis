export type ModelTaskClass =
  | 'trivial'
  | 'simple_text'
  | 'standard_reasoning'
  | 'workflow_synthesis'
  | 'tool_heavy'
  | 'high_risk';

export type ModelTier = 'fast' | 'balanced' | 'flagship' | 'auto' | 'custom';

export type ModelRoutingSource =
  | 'explicit_pin'
  | 'workspace_role'
  | 'workspace_default'
  | 'env_role'
  | 'env_default'
  | 'runtime_detected'
  | 'agent_config'
  | 'fallback'
  | 'custom';

export interface ModelRoutingCandidate {
  model: string;
  runtime?: string | null;
  tier?: ModelTier;
  source?: ModelRoutingSource;
  verified?: boolean;
  costRank?: number;
  latencyRank?: number;
  capabilityHints?: string[];
  reason?: string;
}

export interface ModelRoutingAlternative {
  model: string;
  runtime: string | null;
  modelTier: ModelTier;
  source: ModelRoutingSource;
  verified: boolean;
  reason: string;
}

export interface ModelRoutingDecision {
  taskClass: ModelTaskClass;
  selectedRuntime: string | null;
  selectedModel: string | null;
  modelTier: ModelTier;
  source: ModelRoutingSource;
  explicitPin: boolean;
  verified: boolean;
  reason: string;
  alternatives: ModelRoutingAlternative[];
}

export interface ModelRoutingInput {
  task?: string | null;
  purpose?: string | null;
  role?: string | null;
  runtime?: string | null;
  explicitModel?: string | null;
  currentModel?: string | null;
  candidateModels?: Array<string | ModelRoutingCandidate | null | undefined>;
  requiredAffordances?: string[];
  taskClass?: ModelTaskClass;
}

export function classifyModelTask(input: {
  task?: string | null;
  purpose?: string | null;
  requiredAffordances?: string[];
}): ModelTaskClass {
  const text = `${input.purpose ?? ''}\n${input.task ?? ''}`.toLowerCase();
  const length = text.trim().length;
  const affordances = input.requiredAffordances?.map((value) => value.toLowerCase()) ?? [];

  if (matchesAny(text, HIGH_RISK_SIGNALS)) return 'high_risk';
  if (affordances.length > 0 || matchesAny(text, TOOL_HEAVY_SIGNALS)) return 'tool_heavy';
  if (matchesAny(text, WORKFLOW_SIGNALS)) return 'workflow_synthesis';
  if (length <= 160 && matchesAny(text, TRIVIAL_SIGNALS)) return 'trivial';
  if (length <= 1800 && matchesAny(text, SIMPLE_TEXT_SIGNALS)) return 'simple_text';
  if (length <= 80 && !matchesAny(text, COMPLEXITY_SIGNALS)) return 'trivial';
  return 'standard_reasoning';
}

export function inferModelTierFromId(id: string | null | undefined): ModelTier {
  const lower = (id ?? '').trim().toLowerCase();
  if (!lower) return 'auto';
  if (
    lower === 'auto'
    || lower.includes('auto')
    || lower.includes('provider-default')
    || lower.includes('gateway-default')
    || lower.includes('runtime-default')
    || lower.includes('default')
  ) {
    return 'auto';
  }
  if (
    lower.includes('haiku')
    || lower.includes('mini')
    || lower.includes('nano')
    || lower.includes('flash')
    || lower.includes('lite')
    || lower.includes('small')
    || lower.includes('speed')
    || lower.includes('fast')
  ) {
    return 'fast';
  }
  if (
    lower.includes('opus')
    || lower.includes('flagship')
    || lower.includes('ultra')
    || lower.includes('max')
    || lower.includes('gpt-5.5')
    || /\bo[34]\b/.test(lower)
  ) {
    return 'flagship';
  }
  if (
    lower.includes('sonnet')
    || lower.includes('balanced')
    || lower.includes('medium')
    || lower.includes('standard')
    || lower.includes('gpt-5.4')
    || lower.includes('gpt-5.3')
    || lower.includes('gpt-5.2')
    || lower.includes('gpt-4o')
    || lower.includes('gpt-4.1')
    || lower.includes('gemini')
    || lower.includes('llama')
    || lower.includes('mistral')
    || lower.includes('qwen')
    || lower.includes('deepseek')
    || lower.includes('claude')
  ) {
    return 'balanced';
  }
  return 'balanced';
}

export function routingMetadataForModelId(id: string): {
  tier: ModelTier;
  capabilityHints: string[];
  costRank: number;
  latencyRank: number;
  knownPattern: boolean;
} {
  const tier = inferModelTierFromId(id);
  const lower = id.toLowerCase();
  const capabilityHints: string[] = [];
  if (lower.includes('codex')) capabilityHints.push('code');
  if (lower.includes('vision') || lower.includes('gpt-4o') || lower.includes('gemini')) capabilityHints.push('vision');
  if (lower.includes('reason') || lower.includes('o3') || lower.includes('o4') || lower.includes('opus')) capabilityHints.push('reasoning');
  const knownPattern = tier !== 'balanced'
    || lower.includes('sonnet')
    || lower.includes('claude')
    || lower.includes('gpt-')
    || lower.includes('gemini')
    || lower.includes('llama')
    || lower.includes('mistral')
    || lower.includes('qwen')
    || lower.includes('deepseek');
  return {
    tier,
    capabilityHints,
    costRank: costRankForTier(tier),
    latencyRank: latencyRankForTier(tier),
    knownPattern,
  };
}

export function routeModelForTask(input: ModelRoutingInput): ModelRoutingDecision {
  const taskClass = input.taskClass ?? classifyModelTask({
    task: input.task,
    purpose: input.purpose,
    requiredAffordances: input.requiredAffordances,
  });
  const runtime = clean(input.runtime) ?? clean(input.role);
  const explicitModel = clean(input.explicitModel);
  const candidates = collectCandidates(input, runtime);

  if (explicitModel) {
    const matching = candidates.find((candidate) => sameModel(candidate.model, explicitModel));
    const metadata = routingMetadataForModelId(explicitModel);
    const selected = matching ?? {
      model: explicitModel,
      runtime,
      tier: metadata.tier,
      source: 'explicit_pin' as ModelRoutingSource,
      verified: false,
      costRank: metadata.costRank,
      latencyRank: metadata.latencyRank,
      capabilityHints: metadata.capabilityHints,
    };
    return {
      taskClass,
      selectedRuntime: selected.runtime ?? runtime ?? null,
      selectedModel: explicitModel,
      modelTier: selected.tier ?? metadata.tier,
      source: 'explicit_pin',
      explicitPin: true,
      verified: Boolean(selected.verified),
      reason: `Explicit model pin preserved for ${taskClass}.`,
      alternatives: alternativesFor(candidates, selected, taskClass),
    };
  }

  if (candidates.length === 0) {
    return {
      taskClass,
      selectedRuntime: runtime ?? null,
      selectedModel: null,
      modelTier: 'auto',
      source: 'fallback',
      explicitPin: false,
      verified: false,
      reason: `No concrete model candidates were available; ${runtime ?? 'the runtime'} will use its own default.`,
      alternatives: [],
    };
  }

  const preference = tierPreferenceFor(taskClass, `${input.purpose ?? ''}\n${input.task ?? ''}`);
  const selected = selectCandidate(candidates, preference);
  const selectedTier = selected.tier ?? inferModelTierFromId(selected.model);
  const avoided = candidates.find((candidate) =>
    candidate !== selected
    && (candidate.tier ?? inferModelTierFromId(candidate.model)) === 'flagship'
    && selectedTier !== 'flagship');
  const reason = avoided
    ? `${taskClass} does not need flagship capacity; selected ${selected.model} instead of higher-cost ${avoided.model}.`
    : `${taskClass} routed to the minimum sufficient ${selectedTier} candidate.`;

  return {
    taskClass,
    selectedRuntime: selected.runtime ?? runtime ?? null,
    selectedModel: selected.model,
    modelTier: selectedTier,
    source: selected.source ?? 'custom',
    explicitPin: false,
    verified: Boolean(selected.verified),
    reason,
    alternatives: alternativesFor(candidates, selected, taskClass),
  };
}

export function renderRuntimeRoutingIntelligence(input: {
  decision?: ModelRoutingDecision | null;
  availableRuntimes?: Array<{ runtime: string; models?: string[]; affordances?: string[]; healthy?: boolean | null }>;
  installedExtensions?: string[];
  installedAbilities?: string[];
  requiredAffordances?: string[];
}): string {
  const decision = input.decision;
  const runtimes = input.availableRuntimes?.length
    ? input.availableRuntimes.slice(0, 8).map((item) =>
        `- ${item.runtime}: models=${item.models?.slice(0, 5).join(', ') || 'unknown'} affordances=${item.affordances?.join(', ') || 'chat'} health=${item.healthy === false ? 'degraded' : 'available'}`)
    : ['- Runtime/model candidates are resolved by Agentis at dispatch time.'];
  const affordances = input.requiredAffordances?.length
    ? input.requiredAffordances.join(', ')
    : 'none declared';
  const extensions = input.installedExtensions?.slice(0, 12).join(', ') || 'inspect with agentis.extension.resolve when needed';
  const abilities = input.installedAbilities?.slice(0, 12).join(', ') || 'inspect/create abilities when reusable behavior is needed';
  return [
    'RUNTIME ROUTING INTELLIGENCE',
    decision
      ? `Current recommendation: taskClass=${decision.taskClass} runtime=${decision.selectedRuntime ?? 'runtime-default'} model=${decision.selectedModel ?? 'runtime-default'} tier=${decision.modelTier} explicitPin=${decision.explicitPin ? 'yes' : 'no'}.`
      : 'Current recommendation: ask agentis.routing.preview when model/runtime choice matters.',
    'Routing order: satisfy hard runtime/tool/extension affordances first, classify the task second, then choose the minimum sufficient model tier.',
    'Only explicit node/agent/manual model pins are hard pins. Workspace/env/default models are candidates and may be downgraded for simple work.',
    'Do not use a larger model as a substitute for a missing tool. If the task needs browser, web, integration, listener, or reusable code capability, resolve or create the specialist/extension/ability first.',
    `Required affordances: ${affordances}.`,
    'Available runtimes:',
    ...runtimes,
    `Installed extensions: ${extensions}.`,
    `Installed abilities: ${abilities}.`,
  ].join('\n');
}

function collectCandidates(input: ModelRoutingInput, runtime: string | null | undefined): ModelRoutingCandidate[] {
  const out: ModelRoutingCandidate[] = [];
  const push = (candidate: string | ModelRoutingCandidate | null | undefined, defaultSource: ModelRoutingSource) => {
    if (!candidate) return;
    const value = typeof candidate === 'string' ? { model: candidate } : candidate;
    const model = clean(value.model);
    if (!model) return;
    const metadata = routingMetadataForModelId(model);
    out.push({
      model,
      runtime: value.runtime ?? runtime ?? null,
      tier: value.tier ?? metadata.tier,
      source: value.source ?? (metadata.knownPattern ? defaultSource : 'custom'),
      verified: Boolean(value.verified),
      costRank: value.costRank ?? metadata.costRank,
      latencyRank: value.latencyRank ?? metadata.latencyRank,
      capabilityHints: value.capabilityHints ?? metadata.capabilityHints,
      ...(value.reason ? { reason: value.reason } : {}),
    });
  };

  for (const candidate of input.candidateModels ?? []) push(candidate, 'runtime_detected');
  if (input.currentModel) push({ model: input.currentModel, source: 'workspace_default', verified: false }, 'workspace_default');
  for (const candidate of fallbackCandidatesFor(input.runtime ?? input.role ?? null, input.currentModel ?? null)) push(candidate, 'fallback');

  const deduped = new Map<string, ModelRoutingCandidate>();
  for (const candidate of out) {
    const key = candidate.model.toLowerCase();
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, candidate);
      continue;
    }
    deduped.set(key, {
      ...existing,
      ...candidate,
      verified: existing.verified || candidate.verified,
      source: sourcePrecedence(existing.source, candidate.source),
    });
  }
  return Array.from(deduped.values());
}

function fallbackCandidatesFor(runtime: string | null, currentModel: string | null): ModelRoutingCandidate[] {
  const lower = `${runtime ?? ''} ${currentModel ?? ''}`.toLowerCase();
  if (lower.includes('claude') || lower.includes('anthropic')) {
    return [
      fallbackCandidate('claude-sonnet-4-6', runtime, 'balanced'),
      fallbackCandidate('claude-haiku-4-5', runtime, 'fast'),
      fallbackCandidate('claude-opus-4-8', runtime, 'flagship'),
      fallbackCandidate('claude-opus-4-7', runtime, 'flagship'),
    ];
  }
  if (lower.includes('codex') || lower.includes('openai') || lower.includes('cursor') || lower.includes('gpt-')) {
    return [
      fallbackCandidate('gpt-5.4', runtime, 'balanced'),
      fallbackCandidate('gpt-5.4-mini', runtime, 'fast'),
      fallbackCandidate('gpt-5.5', runtime, 'flagship'),
      fallbackCandidate('gpt-5.3-codex', runtime, 'balanced'),
      fallbackCandidate('gpt-5.2-codex', runtime, 'balanced'),
    ];
  }
  if (lower.includes('gemini') || lower.includes('antigravity') || lower.includes('google')) {
    return [
      fallbackCandidate('gemini-2.5-flash', runtime, 'fast'),
      fallbackCandidate('gemini-2.5-pro', runtime, 'flagship'),
      fallbackCandidate('gemini-2.0-flash', runtime, 'balanced'),
    ];
  }
  if (lower.includes('hermes')) return [fallbackCandidate('hermes-auto', runtime, 'auto')];
  return [];
}

function fallbackCandidate(model: string, runtime: string | null, tier: ModelTier): ModelRoutingCandidate {
  return {
    model,
    runtime,
    tier,
    source: 'fallback',
    verified: false,
    costRank: costRankForTier(tier),
    latencyRank: latencyRankForTier(tier),
  };
}

function selectCandidate(candidates: ModelRoutingCandidate[], preference: ModelTier[]): ModelRoutingCandidate {
  const ranked = [...candidates].sort((a, b) => {
    const tierA = a.tier ?? inferModelTierFromId(a.model);
    const tierB = b.tier ?? inferModelTierFromId(b.model);
    const tierDelta = preferenceIndex(preference, tierA) - preferenceIndex(preference, tierB);
    if (tierDelta !== 0) return tierDelta;
    if (Boolean(a.verified) !== Boolean(b.verified)) return a.verified ? -1 : 1;
    const sourceDelta = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDelta !== 0) return sourceDelta;
    const costDelta = (a.costRank ?? costRankForTier(tierA)) - (b.costRank ?? costRankForTier(tierB));
    if (costDelta !== 0) return costDelta;
    return (a.latencyRank ?? latencyRankForTier(tierA)) - (b.latencyRank ?? latencyRankForTier(tierB));
  });
  return ranked[0]!;
}

function tierPreferenceFor(taskClass: ModelTaskClass, text: string): ModelTier[] {
  if (taskClass === 'trivial') return ['fast', 'balanced', 'auto', 'flagship', 'custom'];
  if (taskClass === 'simple_text') return ['balanced', 'fast', 'auto', 'flagship', 'custom'];
  if (taskClass === 'workflow_synthesis') {
    return matchesAny(text.toLowerCase(), COMPLEXITY_SIGNALS)
      ? ['flagship', 'balanced', 'fast', 'auto', 'custom']
      : ['balanced', 'fast', 'flagship', 'auto', 'custom'];
  }
  if (taskClass === 'tool_heavy') return ['balanced', 'flagship', 'fast', 'auto', 'custom'];
  if (taskClass === 'high_risk') return ['flagship', 'balanced', 'fast', 'auto', 'custom'];
  return ['balanced', 'flagship', 'fast', 'auto', 'custom'];
}

function alternativesFor(
  candidates: ModelRoutingCandidate[],
  selected: ModelRoutingCandidate,
  taskClass: ModelTaskClass,
): ModelRoutingAlternative[] {
  return candidates
    .filter((candidate) => !sameModel(candidate.model, selected.model))
    .slice(0, 8)
    .map((candidate) => {
      const tier = candidate.tier ?? inferModelTierFromId(candidate.model);
      return {
        model: candidate.model,
        runtime: candidate.runtime ?? null,
        modelTier: tier,
        source: candidate.source ?? 'custom',
        verified: Boolean(candidate.verified),
        reason: tier === 'flagship' && (selected.tier ?? inferModelTierFromId(selected.model)) !== 'flagship'
          ? `Higher cost than needed for ${taskClass}.`
          : `Available ${tier} candidate.`,
      };
    });
}

function costRankForTier(tier: ModelTier): number {
  if (tier === 'fast') return 10;
  if (tier === 'balanced') return 30;
  if (tier === 'auto') return 40;
  if (tier === 'custom') return 50;
  return 90;
}

function latencyRankForTier(tier: ModelTier): number {
  if (tier === 'fast') return 10;
  if (tier === 'balanced') return 30;
  if (tier === 'auto') return 40;
  if (tier === 'custom') return 50;
  return 80;
}

function preferenceIndex(preference: ModelTier[], tier: ModelTier): number {
  const index = preference.indexOf(tier);
  return index >= 0 ? index : preference.length;
}

function sourceRank(source: ModelRoutingSource | undefined): number {
  switch (source) {
    case 'runtime_detected': return 0;
    case 'agent_config': return 1;
    case 'workspace_role': return 2;
    case 'workspace_default': return 3;
    case 'env_role': return 4;
    case 'env_default': return 5;
    case 'fallback': return 6;
    case 'custom': return 7;
    case 'explicit_pin': return -1;
    default: return 8;
  }
}

function sourcePrecedence(a: ModelRoutingSource | undefined, b: ModelRoutingSource | undefined): ModelRoutingSource | undefined {
  if (!a) return b;
  if (!b) return a;
  return sourceRank(a) <= sourceRank(b) ? a : b;
}

function sameModel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function clean(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const TRIVIAL_SIGNALS = [
  /\bclassif(y|ication)\b/,
  /\bextract\b/,
  /\btag\b/,
  /\bslug\b/,
  /\btitle\b/,
  /\bformat\b/,
  /\bgrammar\b/,
  /\bproofread\b/,
  /\bone[- ]?liner\b/,
];

const SIMPLE_TEXT_SIGNALS = [
  /\bwrite\b/,
  /\bdraft\b/,
  /\brewrite\b/,
  /\bsummar(y|ize|ise)\b/,
  /\bemail\b/,
  /\bmessage\b/,
  /\bcopy\b/,
  /\bpost\b/,
  /\bsubject\b/,
  /\bhtml\b/,
  /\bmarkdown\b/,
  /\btext generation\b/,
];

const WORKFLOW_SIGNALS = [
  /\bworkflow\b/,
  /\bautomation\b/,
  /\btrigger\b/,
  /\bnode\b/,
  /\bbuild_workflow\b/,
  /\bsynthesis\b/,
];

const TOOL_HEAVY_SIGNALS = [
  /\bbrowser\b/,
  /\bscrap(e|ing)\b/,
  /\bweb\b/,
  /\bapi\b/,
  /\bintegration\b/,
  /\bgithub\b/,
  /\bdeploy\b/,
  /\bdatabase\b/,
  /\bfile\b/,
  /\bspreadsheet\b/,
  /\bextension\b/,
  /\bability\b/,
  /\blistener\b/,
  /\bconnector\b/,
];

const HIGH_RISK_SIGNALS = [
  /\bproduction\b/,
  /\bdelete\b/,
  /\bdestroy\b/,
  /\bpayment\b/,
  /\bwire transfer\b/,
  /\bcredential\b/,
  /\bsecret\b/,
  /\bsecurity\b/,
  /\bmedical\b/,
  /\blegal\b/,
  /\bcompliance\b/,
  /\bfinancial advice\b/,
];

const COMPLEXITY_SIGNALS = [
  /\bcomplex\b/,
  /\bmulti[- ]agent\b/,
  /\bswarm\b/,
  /\bhierarchical\b/,
  /\bapproval\b/,
  /\bguardrail\b/,
  /\bevaluate\b/,
  /\bvalidate\b/,
  /\brepair\b/,
  /\bintegration\b/,
  /\blistener\b/,
  /\bsecurity\b/,
];
