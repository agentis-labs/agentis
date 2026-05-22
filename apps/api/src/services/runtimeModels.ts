import type { V1HarnessAdapterType } from './harnessProbe.js';

export interface RuntimeModelOption {
  id: string;
  label: string;
  provider: string;
  tier?: 'flagship' | 'balanced' | 'fast' | 'auto';
  recommended?: boolean;
  description?: string;
}

export interface RuntimeModelCatalog {
  adapterType: V1HarnessAdapterType;
  defaultModel: string | null;
  defaultLabel: string;
  supportsManual: boolean;
  models: RuntimeModelOption[];
}

const OPENAI_MODELS: RuntimeModelOption[] = [
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'OpenAI', tier: 'balanced', recommended: true, description: 'Default coding agent model.' },
  { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'OpenAI', tier: 'flagship', description: 'Frontier model for broad reasoning and coding.' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'OpenAI', tier: 'fast', description: 'Lower latency and cost for lighter work.' },
  { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'OpenAI', tier: 'balanced', description: 'Stable professional workhorse model.' },
];

const CLAUDE_MODELS: RuntimeModelOption[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic', tier: 'balanced', recommended: true, description: 'Balanced default for Claude Code.' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'Anthropic', tier: 'flagship', description: 'Deeper reasoning for harder tasks.' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'Anthropic', tier: 'fast', description: 'Fast, low-cost Claude option.' },
];

const CURSOR_MODELS: RuntimeModelOption[] = [
  { id: 'auto', label: 'Auto', provider: 'Cursor', tier: 'auto', recommended: true, description: 'Let Cursor choose the model.' },
  ...OPENAI_MODELS.filter((model) => model.id !== 'gpt-5.3-codex'),
  ...CLAUDE_MODELS,
];

const HERMES_MODELS: RuntimeModelOption[] = [
  { id: 'hermes-auto', label: 'Hermes Auto', provider: 'Hermes', tier: 'auto', recommended: true, description: 'Use the Hermes agent default.' },
  ...OPENAI_MODELS,
  ...CLAUDE_MODELS,
];

const OPENCLAW_MODELS: RuntimeModelOption[] = [
  ...OPENAI_MODELS,
  ...CLAUDE_MODELS,
];

const HTTP_MODELS: RuntimeModelOption[] = [
  ...OPENAI_MODELS,
  ...CLAUDE_MODELS,
];

export function listRuntimeModels(adapterType: V1HarnessAdapterType): RuntimeModelCatalog {
  const models = modelsFor(adapterType);
  return {
    adapterType,
    defaultModel: defaultModelFor(adapterType),
    defaultLabel: defaultLabelFor(adapterType),
    supportsManual: true,
    models,
  };
}

export function defaultModelFor(adapterType: V1HarnessAdapterType): string | null {
  if (adapterType === 'codex') return 'gpt-5.3-codex';
  if (adapterType === 'claude_code') return 'claude-sonnet-4-6';
  if (adapterType === 'cursor') return 'auto';
  if (adapterType === 'hermes_agent') return 'hermes-auto';
  if (adapterType === 'openclaw') return 'gateway-default';
  return 'provider-default';
}

function defaultLabelFor(adapterType: V1HarnessAdapterType): string {
  if (adapterType === 'openclaw') return 'Gateway default';
  if (adapterType === 'http') return 'Provider default';
  return 'Runtime default';
}

function modelsFor(adapterType: V1HarnessAdapterType): RuntimeModelOption[] {
  if (adapterType === 'codex') return OPENAI_MODELS;
  if (adapterType === 'claude_code') return CLAUDE_MODELS;
  if (adapterType === 'cursor') return CURSOR_MODELS;
  if (adapterType === 'hermes_agent') return HERMES_MODELS;
  if (adapterType === 'openclaw') return OPENCLAW_MODELS;
  return HTTP_MODELS;
}
