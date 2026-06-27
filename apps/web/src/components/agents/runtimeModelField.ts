import type { AdapterType, RuntimeConfig } from './RuntimePicker';

export type RuntimeModelField =
  | 'openclawModel'
  | 'hermesModel'
  | 'claudeModel'
  | 'codexModel'
  | 'cursorModel'
  | 'antigravityModel'
  | 'httpModel';

const RUNTIME_MODEL_FIELDS: Record<AdapterType, RuntimeModelField> = {
  openclaw: 'openclawModel',
  hermes_agent: 'hermesModel',
  claude_code: 'claudeModel',
  codex: 'codexModel',
  cursor: 'cursorModel',
  antigravity: 'antigravityModel',
  http: 'httpModel',
};

export function runtimeModelFieldFor(adapterType: AdapterType): RuntimeModelField {
  return RUNTIME_MODEL_FIELDS[adapterType];
}

export function runtimeModelValue(config: RuntimeConfig, adapterType: AdapterType): string {
  return config[runtimeModelFieldFor(adapterType)];
}

export function withRuntimeModel(config: RuntimeConfig, adapterType: AdapterType, model: string): RuntimeConfig {
  return {
    ...config,
    [runtimeModelFieldFor(adapterType)]: model,
  } as RuntimeConfig;
}
