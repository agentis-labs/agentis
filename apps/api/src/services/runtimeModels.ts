import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { V1HarnessAdapterType } from './harnessProbe.js';
import { inferModelTierFromId, routingMetadataForModelId, type ModelTier } from './modelRoutingPolicy.js';

export interface RuntimeModelOption {
  id: string;
  label: string;
  provider: string;
  tier?: ModelTier;
  recommended?: boolean;
  description?: string;
  source: 'runtime' | 'profile' | 'agent_config' | 'fallback' | 'custom';
  verified: boolean;
  capabilityHints?: string[];
  costRank?: number;
  latencyRank?: number;
}

export interface RuntimeModelCatalog {
  adapterType: V1HarnessAdapterType;
  defaultModel: string | null;
  defaultLabel: string;
  supportsManual: boolean;
  models: RuntimeModelOption[];
}

export interface DetectedRuntimeState {
  model: string | null;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  fastMode?: boolean;
}

export async function listRuntimeModels(
  adapterType: V1HarnessAdapterType,
  agentId: string | null = null,
  db: AgentisSqliteDb | null = null,
): Promise<RuntimeModelCatalog> {
  const agent = agentId && db
    ? db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()
    : null;
  const configuredModel = agent ? modelConfiguredOnAgent(agent) : null;
  const detectedRuntime = detectRuntimeState(adapterType);
  const detectedRuntimeModel = detectedRuntime.model;
  const runtimeDefaultModel = detectedRuntimeModel ?? defaultModelFor(adapterType);
  const seedModels = seedModelOptions({
    adapterType,
    configuredModel,
    runtimeDefaultModel,
    runtimeDefaultDetected: Boolean(detectedRuntimeModel),
  });
  let dynamicModels: RuntimeModelOption[] = [];

  // 1. Fetch from direct upstream APIs if environment variables are set
  if (adapterType === 'codex' || adapterType === 'cursor') {
    const openai = await fetchOpenAiModels(adapterType);
    dynamicModels = [...dynamicModels, ...openai];
  }
  if (adapterType === 'claude_code' || adapterType === 'cursor') {
    const anthropic = await fetchAnthropicModels(adapterType);
    dynamicModels = [...dynamicModels, ...anthropic];
  }

  // 2. Fetch from configured http / openclaw endpoints at runtime
  if (agent) {
    try {
      if (agent.config) {
        const config = typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config;
        if (adapterType === 'http' && config.baseUrl) {
          const headers: Record<string, string> = {};
          if (config.headers) {
            Object.assign(headers, typeof config.headers === 'string' ? JSON.parse(config.headers) : config.headers);
          }
          if (config.authToken) {
            headers.Authorization = `Bearer ${config.authToken}`;
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

  const models = mergeModels(seedModels, dynamicModels);

  return {
    adapterType,
    defaultModel: runtimeDefaultModel,
    defaultLabel: defaultLabelFor(adapterType, Boolean(detectedRuntimeModel)),
    supportsManual: true,
    models,
  };
}

export function modelConfiguredOnAgent(agent: { runtimeModel?: string | null; config?: unknown }): string | null {
  if (typeof agent.runtimeModel === 'string' && agent.runtimeModel.trim()) return agent.runtimeModel.trim();
  let config: Record<string, unknown> | null = null;
  try {
    config = typeof agent.config === 'string' ? JSON.parse(agent.config) as Record<string, unknown> : agent.config as Record<string, unknown> | null;
  } catch {
    return null;
  }
  const model = config && typeof config.model === 'string' ? config.model.trim() : '';
  return model || null;
}

function configuredModelOption(id: string): RuntimeModelOption {
  const metadata = routingMetadataForModelId(id);
  return {
    id,
    label: id,
    provider: 'Selected agent',
    tier: metadata.tier,
    recommended: true,
    description: metadata.knownPattern
      ? 'Configured on the selected agent runtime.'
      : 'Custom model ID configured on the selected agent runtime.',
    source: 'agent_config',
    verified: false,
    capabilityHints: metadata.capabilityHints,
    costRank: metadata.costRank,
    latencyRank: metadata.latencyRank,
  };
}

export function defaultModelFor(adapterType: V1HarnessAdapterType): string | null {
  // gpt-5.5 is the broadly-supported Codex default — notably the codex-with-a-
  // ChatGPT-account path rejects the `*-codex` model ids (e.g. gpt-5.3-codex)
  // with "model is not supported". Defaulting here keeps a fresh Codex agent
  // runnable out of the box; users on an API key can still pick a `*-codex` id.
  if (adapterType === 'codex') return 'gpt-5.5';
  if (adapterType === 'claude_code') return 'claude-sonnet-4-6';
  if (adapterType === 'cursor') return 'auto';
  if (adapterType === 'hermes_agent') return 'hermes-auto';
  if (adapterType === 'openclaw') return 'gateway-default';
  return 'provider-default';
}

function defaultLabelFor(adapterType: V1HarnessAdapterType, detected: boolean): string {
  if (detected) return 'Detected runtime default';
  if (adapterType === 'openclaw') return 'Gateway default';
  if (adapterType === 'http') return 'Provider default';
  return 'Runtime default';
}

function seedModelOptions(args: {
  adapterType: V1HarnessAdapterType;
  configuredModel: string | null;
  runtimeDefaultModel: string | null;
  runtimeDefaultDetected: boolean;
}): RuntimeModelOption[] {
  const options: RuntimeModelOption[] = [];
  if (args.configuredModel) options.push(configuredModelOption(args.configuredModel));
  if (args.runtimeDefaultModel && args.runtimeDefaultModel !== args.configuredModel) {
    options.push(runtimeDefaultModelOption(args.adapterType, args.runtimeDefaultModel, args.runtimeDefaultDetected));
  }
  options.push(...fallbackModelOptions(args.adapterType));
  return options;
}

function runtimeDefaultModelOption(
  adapterType: V1HarnessAdapterType,
  id: string,
  detected: boolean,
): RuntimeModelOption {
  const metadata = routingMetadataForModelId(id);
  return {
    id,
    label: id,
    provider: providerLabelFor(adapterType),
    tier: metadata.tier,
    recommended: true,
    description: detected
      ? 'Detected from the runtime configuration on this machine.'
      : 'Agentis fallback default for this runtime.',
    source: detected ? 'profile' : 'fallback',
    verified: detected,
    capabilityHints: metadata.capabilityHints,
    costRank: metadata.costRank,
    latencyRank: metadata.latencyRank,
  };
}

function providerLabelFor(adapterType: V1HarnessAdapterType): string {
  if (adapterType === 'codex') return 'OpenAI';
  if (adapterType === 'claude_code') return 'Anthropic';
  if (adapterType === 'cursor') return 'Cursor';
  if (adapterType === 'hermes_agent') return 'Hermes';
  if (adapterType === 'openclaw') return 'OpenClaw';
  return 'HTTP';
}

export function detectRuntimeState(adapterType: V1HarnessAdapterType): DetectedRuntimeState {
  if (adapterType === 'claude_code') {
    return {
      model: readConfiguredModel([
        path.resolve(process.cwd(), '.claude', 'settings.json'),
        path.join(homePath(), '.claude', 'settings.json'),
      ]) ?? firstConfiguredEnv(process.env.ANTHROPIC_MODEL),
    };
  }
  if (adapterType === 'codex') {
    const explicitCodexHome = process.env.CODEX_HOME;
    const config = readCodexTomlConfig([
      resolveExplicitCodexConfigPath(explicitCodexHome),
      resolveCodexConfigPath(process.cwd()),
      ...(explicitCodexHome?.trim() ? [] : [resolveCodexConfigPath(homePath())]),
    ]);
    return {
      model: firstConfiguredEnv(
        process.env.OPENAI_MODEL,
        stringValue(config.model),
        readConfiguredModel([
          path.resolve(process.cwd(), '.codex', 'settings.json'),
          path.join(homePath(), '.codex', 'settings.json'),
        ]),
      ),
      reasoningEffort: reasoningEffortValue(config.model_reasoning_effort),
      fastMode: codexFastModeValue(config.service_tier),
    };
  }
  return { model: null };
}

function readConfiguredModel(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      const model = firstConfiguredEnv(
        stringValue(raw.model),
        stringValue(raw.defaultModel),
        stringValue(raw.modelName),
      );
      if (model) return model;
    } catch {
      // Ignore malformed local settings and keep looking.
    }
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstConfiguredEnv(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

async function fetchOpenAiModels(adapterType: V1HarnessAdapterType): Promise<RuntimeModelOption[]> {
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
    return parseModelsResponse(await res.json(), adapterType, 'OpenAI');
  } catch {
    return [];
  }
}

async function fetchAnthropicModels(adapterType: V1HarnessAdapterType): Promise<RuntimeModelOption[]> {
  const apiKey = process.env.OPENANTHROPIC_API_KEY;
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
    return parseModelsResponse(await res.json(), adapterType, 'Anthropic');
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
      return parseModelsResponse(await resFallback.json(), 'http');
    }
    return parseModelsResponse(await res.json(), 'http');
  } catch (err) {
    console.error('Failed to fetch dynamic models', err);
    return [];
  }
}

function parseModelsResponse(
  json: any,
  adapterType: V1HarnessAdapterType | 'http',
  providerFallback?: string,
): RuntimeModelOption[] {
  if (!json || typeof json !== 'object') return [];
  const list = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  return list.map((item: any) => {
    const id = typeof item === 'string' ? item : item?.id;
    if (!id || typeof id !== 'string' || !isRelevantModelForAdapter(adapterType, id)) return null;
    const provider = providerName(item?.owned_by ?? item?.provider ?? providerFallback ?? 'Provider');
    return {
      id,
      label: id,
      provider,
      tier: inferModelTierFromId(id),
      description: `Dynamically fetched model ${id}.`,
      source: 'runtime',
      verified: true,
      ...routingOptionMetadata(id),
    };
  }).filter((m: any): m is RuntimeModelOption => m !== null);
}

function mergeModels(staticModels: RuntimeModelOption[], dynamicModels: RuntimeModelOption[]): RuntimeModelOption[] {
  const merged: RuntimeModelOption[] = [];
  const seen = new Set<string>();
  for (const model of [...dynamicModels, ...staticModels]) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

function fallbackModelOptions(adapterType: V1HarnessAdapterType): RuntimeModelOption[] {
  if (adapterType === 'codex') {
    return [
      // gpt-5.5 first + recommended: it's the model that works on both API-key
      // and ChatGPT-account Codex auth. The `*-codex` ids are rejected on a
      // ChatGPT account, so they're offered but not the default.
      option('gpt-5.5', 'OpenAI', true),
      option('gpt-5.4', 'OpenAI'),
      option('gpt-5.4-mini', 'OpenAI'),
      option('gpt-5.3-codex', 'OpenAI'),
      option('gpt-5.2-codex', 'OpenAI'),
    ];
  }
  if (adapterType === 'claude_code') {
    return [
      option('claude-sonnet-4-6', 'Anthropic', true),
      option('claude-haiku-4-5', 'Anthropic'),
      option('claude-haiku-3-5', 'Anthropic'),
      option('claude-opus-4-8', 'Anthropic'),
      option('claude-opus-4-7', 'Anthropic'),
    ];
  }
  return [];
}

function option(id: string, provider: string, recommended = false): RuntimeModelOption {
  const metadata = routingMetadataForModelId(id);
  return {
    id,
    label: id,
    provider,
    tier: metadata.tier,
    recommended,
    description: 'Known upstream runtime model.',
    source: 'fallback',
    verified: false,
    capabilityHints: metadata.capabilityHints,
    costRank: metadata.costRank,
    latencyRank: metadata.latencyRank,
  };
}

function routingOptionMetadata(id: string): Pick<RuntimeModelOption, 'capabilityHints' | 'costRank' | 'latencyRank'> {
  const metadata = routingMetadataForModelId(id);
  return {
    capabilityHints: metadata.capabilityHints,
    costRank: metadata.costRank,
    latencyRank: metadata.latencyRank,
  };
}

function isRelevantModelForAdapter(adapterType: V1HarnessAdapterType | 'http', id: string): boolean {
  const lower = id.toLowerCase();
  if (adapterType === 'claude_code') return lower.startsWith('claude-');
  if (adapterType === 'codex' || adapterType === 'cursor') {
    if (
      lower.includes('embedding')
      || lower.includes('image')
      || lower.includes('audio')
      || lower.includes('realtime')
      || lower.includes('moderation')
      || lower.includes('transcribe')
      || lower.includes('tts')
      || lower.includes('whisper')
      || lower.includes('search-preview')
      || lower.includes('computer-use')
    ) {
      return false;
    }
    return (
      lower.includes('codex')
      || lower.startsWith('gpt-5')
      || lower.startsWith('gpt-4.1')
      || lower.startsWith('gpt-4o')
      || lower.startsWith('gpt-4')
      || lower.startsWith('o1')
      || lower.startsWith('o3')
      || lower.startsWith('o4')
    );
  }
  return true;
}

function providerName(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : 'Provider';
}

function homePath(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

function resolveCodexConfigPath(base: string): string {
  return path.join(base, '.codex', 'config.toml');
}

function resolveExplicitCodexConfigPath(base: string | undefined): string {
  return base?.trim() ? path.join(base, 'config.toml') : '';
}

function readCodexTomlConfig(candidates: string[]): Record<string, string> {
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const text = readFileSync(candidate, 'utf8');
      const firstSection = text.search(/^\s*\[/m);
      const head = firstSection === -1 ? text : text.slice(0, firstSection);
      const entries = Array.from(head.matchAll(/^[ \t]*([A-Za-z0-9_.-]+)[ \t]*=[ \t]*["']?([^"'\r\n]+)["']?[ \t]*$/gm));
      if (entries.length === 0) continue;
      return Object.fromEntries(entries.map((match) => [match[1]!, match[2]!.trim()]));
    } catch {
      // Ignore malformed local config and keep looking.
    }
  }
  return {};
}

function reasoningEffortValue(value: string | undefined): DetectedRuntimeState['reasoningEffort'] {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : undefined;
}

function codexFastModeValue(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (value === 'fast') return true;
  if (value === 'default' || value === 'flex') return false;
  return undefined;
}
