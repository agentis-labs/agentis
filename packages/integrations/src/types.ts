export interface ConnectorExecuteOptions {
  operation: string;
  params: Record<string, unknown>;
  credential: Record<string, unknown> | null;
  inputData?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ConnectorModule {
  service: string;
  operations: readonly string[];
  execute(opts: ConnectorExecuteOptions): Promise<Record<string, unknown>>;
}

export type IntegrationAuthType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
export type IntegrationHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface IntegrationAuthConfig {
  type: IntegrationAuthType;
  headerName?: string;
  queryParamName?: string;
}

export interface IntegrationOperationSpec {
  name: string;
  method: IntegrationHttpMethod;
  urlTemplate: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  bodyTemplate?: unknown;
  paramSchema?: Record<string, unknown>;
  responseMode?: 'auto' | 'json' | 'text';
}

export interface IntegrationManifest {
  service: string;
  name: string;
  version: string;
  category: string;
  description: string;
  operations: string[];
  operationSpecs?: IntegrationOperationSpec[];
  auth?: IntegrationAuthConfig;
  credentialSchema: Record<string, unknown>;
  nodeConfig: { kind: 'integration'; service: string; operation?: string };
  icon?: string;
  docsUrl?: string;
  builtin: boolean;
  runtime: 'implemented' | 'manifest_only';
}
