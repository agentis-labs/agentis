import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
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
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'OpenAI', tier: 'flagship', description: 'Ultimate frontier model with supreme intelligence.' },
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

export async function listRuntimeModels(
  adapterType: V1HarnessAdapterType,
  agentId: string | null = null,
  db: AgentisSqliteDb | null = null,
): Promise<RuntimeModelCatalog> {
  const staticModels = modelsFor(adapterType);
  let dynamicModels: RuntimeModelOption[] = [];

  // 1. Fetch from direct upstream APIs if environment variables are set
  if (adapterType === 'codex' || adapterType === 'cursor') {
    const openai = await fetchOpenAiModels();
    dynamicModels = [...dynamicModels, ...openai];
  }
  if (adapterType === 'claude_code' || adapterType === 'cursor') {
    const anthropic = await fetchAnthropicModels();
    dynamicModels = [...dynamicModels, ...anthropic];
  }

  // 2. Fetch from configured http / openclaw endpoints at runtime
  if (agentId && db) {
    try {
      const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
      if (agent && agent.config) {
        const config = typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config;
        if (adapterType === 'http' && config.baseUrl) {
          const headers: Record<string, string> = {};
          if (config.headers) {
            Object.assign(headers, typeof config.headers === 'string' ? JSON.parse(config.headers) : config.headers);
          }
          if (config.authToken) {
            headers['Authorization'] = `Bearer ${config.authToken}`;
          }
          const fetched = await fetchDynamicModels(config.baseUrl, headers);
          dynamicModels = [...dynamicModels, ...fetched];
        } else if (adapterType === 'openclaw' && config.gatewayUrl) {
          const fetched = await fetchDynamicModels(config.gatewayUrl.replace(/^ws/, 'http'), {});
          dynamicModels = [...dynamicModels, ...fetched];
        }
      }
    } catch (err) {
      console.error('Failed to fetch dynamic models for agent config', err);
    }
  }

  const models = mergeModels(staticModels, dynamicModels);

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

async function fetchOpenAiModels(): Promise<RuntimeModelOption[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return parseModelsResponse(await res.json());
  } catch {
    return [];
  }
}

async function fetchAnthropicModels(): Promise<RuntimeModelOption[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return parseModelsResponse(await res.json());
  } catch {
    return [];
  }
}

async function fetchDynamicModels(baseUrl: string, headers: Record<string, string>): Promise<RuntimeModelOption[]> {
  try {
    const normalized = baseUrl.replace(/\/$/, '');
    const url = new URL('/v1/models', normalized).toString();
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      const urlFallback = new URL('/models', normalized).toString();
      const resFallback = await fetch(urlFallback, { headers, signal: AbortSignal.timeout(5000) });
      if (!resFallback.ok) return [];
      return parseModelsResponse(await resFallback.json());
    }
    return parseModelsResponse(await res.json());
  } catch (err) {
    console.error('Failed to fetch dynamic models', err);
    return [];
  }
}

function parseModelsResponse(json: any): RuntimeModelOption[] {
  if (!json || typeof json !== 'object') return [];
  const list = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  return list.map((item: any) => {
    const id = typeof item === 'string' ? item : item?.id;
    if (!id || typeof id !== 'string') return null;
    const provider = item?.owned_by ?? 'Provider';
    return {
      id,
      label: id,
      provider: provider.charAt(0).toUpperCase() + provider.slice(1),
      tier: inferTierFromModelId(id),
      description: `Dynamically fetched model ${id}.`,
    };
  }).filter((m: any): m is RuntimeModelOption => m !== null);
}

function inferTierFromModelId(id: string): 'flagship' | 'balanced' | 'fast' | 'auto' {
  const lower = id.toLowerCase();
  if (lower.includes('opus') || lower.includes('flagship') || lower.includes('pro') || lower.includes('3.5-sonnet') || lower.includes('4-sonnet') || lower.includes('gpt-4o') || lower.includes('gpt-4') || lower.includes('gpt-5')) {
    return 'flagship';
  }
  if (lower.includes('haiku') || lower.includes('mini') || lower.includes('flash') || lower.includes('speed') || lower.includes('fast')) {
    return 'fast';
  }
  return 'balanced';
}

function mergeModels(staticModels: RuntimeModelOption[], dynamicModels: RuntimeModelOption[]): RuntimeModelOption[] {
  const seen = new Set(staticModels.map((m) => m.id));
  const uniqueDynamic = dynamicModels.filter((m) => !seen.has(m.id));
  return [...uniqueDynamic, ...staticModels];
}
