import { AgentisError } from '@agentis/core';
import type { ConnectorExecuteOptions, ConnectorModule } from './types.js';

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
    return connector.execute(opts);
  }
}
