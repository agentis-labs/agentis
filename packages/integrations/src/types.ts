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
  operationContracts?: Record<string, ConnectorOperationContract>;
  execute(opts: ConnectorExecuteOptions): Promise<Record<string, unknown>>;
}

export interface ConnectorOperationContract {
  /** Canonical fields this operation requires. */
  required?: readonly string[];
  /** At least one field from each group must be present. */
  requiredAny?: ReadonlyArray<readonly string[]>;
  /** Canonical field -> accepted aliases. Explicit canonical values still win. */
  aliases?: Record<string, readonly string[]>;
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
  operationContracts?: Record<string, ConnectorOperationContract>;
  operationSpecs?: IntegrationOperationSpec[];
  auth?: IntegrationAuthConfig;
  credentialSchema: Record<string, unknown>;
  nodeConfig: { kind: 'integration'; service: string; operation?: string };
  icon?: string;
  docsUrl?: string;
  /** One line telling the operator exactly where to get this credential. */
  authHint?: string;
  builtin: boolean;
  runtime: 'implemented' | 'manifest_only';
}



