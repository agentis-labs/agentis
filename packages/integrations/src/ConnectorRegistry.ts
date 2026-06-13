import { AgentisError } from '@agentis/core';
import type { ConnectorExecuteOptions, ConnectorModule, ConnectorOperationContract } from './types.js';

export class ConnectorRegistry {
  readonly #connectors = new Map<string, ConnectorModule>();

  constructor(connectors: ConnectorModule[] = []) {
    for (const connector of connectors) this.register(connector);
  }

  register(connector: ConnectorModule): void {
    this.#connectors.set(connector.service, connector);
  }

  has(service: string): boolean {
    return this.#connectors.has(service);
  }

  get(service: string): ConnectorModule {
    const connector = this.#connectors.get(service);
    if (!connector) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `integration service is not registered: ${service}`);
    }
    return connector;
  }

  list(): ConnectorModule[] {
    return [...this.#connectors.values()].sort((a, b) => a.service.localeCompare(b.service));
  }

  async execute(service: string, opts: ConnectorExecuteOptions): Promise<Record<string, unknown>> {
    const connector = this.get(service);
    if (!connector.operations.includes(opts.operation)) {
      throw new AgentisError(
        'INTEGRATION_OPERATION_FAILED',
        `operation '${opts.operation}' is not supported by ${service}`,
        { details: { service, operation: opts.operation, supportedOperations: connector.operations } },
      );
    }
    const contract = connector.operationContracts?.[opts.operation];
    return connector.execute({
      ...opts,
      params: contract ? normalizeParams(opts.params, opts.inputData ?? {}, contract) : opts.params,
    });
  }
}

function normalizeParams(
  params: Record<string, unknown>,
  inputData: Record<string, unknown>,
  contract: ConnectorOperationContract,
): Record<string, unknown> {
  const out = { ...params };
  const candidates = [
    ...parsedObjectsFrom(params),
    params,
    ...parsedObjectsFrom(inputData),
    inputData,
  ];
  for (const [canonical, aliases] of Object.entries(contract.aliases ?? {})) {
    if (isPresent(out[canonical])) continue;
    for (const source of candidates) {
      const value = firstPresent(source, [canonical, ...aliases]);
      if (isPresent(value)) {
        out[canonical] = value;
        break;
      }
    }
  }
  for (const field of contract.required ?? []) {
    if (!isPresent(out[field])) {
      throw new AgentisError('VALIDATION_FAILED', `${field} is required`);
    }
  }
  for (const group of contract.requiredAny ?? []) {
    if (!group.some((field) => isPresent(out[field]))) {
      throw new AgentisError('VALIDATION_FAILED', `one of ${group.join(', ')} is required`);
    }
  }
  return out;
}

function firstPresent(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (isPresent(value)) return value;
  }
  return undefined;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function parsedObjectsFrom(source: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const key of ['text', 'output', 'result', 'content', 'message', 'response', 'answer', 'body', 'markdown', 'markdownBody', 'digest']) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(value as Record<string, unknown>);
      continue;
    }
    if (typeof value === 'string') {
      const parsed = parseJsonObject(value);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
