import { AgentisError } from '@agentis/core';
import type {
  ConnectorModule,
  IntegrationAuthConfig,
  IntegrationManifest,
  IntegrationOperationSpec,
} from '../types.js';
import { genericHttpConnector } from './apiConnectors.js';
import { executeHttpRequest, jsonRecordOf, stringValue } from './http.js';

const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\{([A-Za-z0-9_.-]+)\}/gu;

export function manifestHttpConnector(manifest: IntegrationManifest): ConnectorModule {
  const operations = manifest.operations.length > 0
    ? manifest.operations
    : (manifest.operationSpecs ?? []).map((spec) => spec.name);
  const generic = genericHttpConnector(manifest.service, operations);

  return {
    service: manifest.service,
    operations,
    async execute(opts) {
      const spec = (manifest.operationSpecs ?? []).find((candidate) => candidate.name === opts.operation);
      if (!spec) return generic.execute(opts);
      return executeManifestOperation({
        manifest,
        spec,
        params: opts.params,
        credential: opts.credential,
        inputData: opts.inputData ?? {},
        timeoutMs: opts.timeoutMs,
      });
    },
  };
}

export async function executeManifestOperation(args: {
  manifest: IntegrationManifest;
  spec: IntegrationOperationSpec;
  params: Record<string, unknown>;
  credential: Record<string, unknown> | null;
  inputData?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const scope = {
    params: args.params,
    credential: args.credential ?? {},
    input: args.inputData ?? {},
  };
  const query = renderStringRecord(args.spec.query ?? {}, scope);
  const headers = renderStringRecord(args.spec.headers ?? {}, scope);
  applyManifestAuth(args.manifest.auth, headers, query, args.credential);

  const method = args.spec.method.toUpperCase();
  const body =
    args.spec.bodyTemplate !== undefined
      ? renderTemplateValue(args.spec.bodyTemplate, scope)
      : args.params.body;

  return executeHttpRequest(
    {
      url: renderTemplateString(args.spec.urlTemplate, scope),
      method,
      query: { ...query, ...jsonRecordOf(args.params.query) },
      headers: { ...headers, ...jsonRecordOf(args.params.headers) },
      body,
      responseMode: args.spec.responseMode ?? args.params.responseMode,
      throwOnHttpError: args.params.throwOnHttpError,
    },
    args.manifest.auth ? null : args.credential,
    args.timeoutMs,
  );
}

function applyManifestAuth(
  auth: IntegrationAuthConfig | undefined,
  headers: Record<string, string>,
  query: Record<string, string>,
  credential: Record<string, unknown> | null,
): void {
  if (!auth || auth.type === 'none') return;
  if (!credential) {
    throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', `${auth.type} integration requires a credential`);
  }

  if (auth.type === 'bearer' || auth.type === 'oauth2') {
    const token = credentialString(credential, ['access_token', 'accessToken', 'bearerToken', 'token', 'value']);
    headers.authorization = `Bearer ${token}`;
    return;
  }

  if (auth.type === 'api_key') {
    const apiKey = credentialString(credential, ['apiKey', 'key', 'token', 'value']);
    const headerName = auth.headerName ?? stringValue(credential.headerName);
    if (headerName) {
      headers[headerName.toLowerCase()] = apiKey;
      return;
    }
    const queryParamName = auth.queryParamName ?? stringValue(credential.queryParamName);
    if (queryParamName) {
      query[queryParamName] = apiKey;
      return;
    }
    headers.authorization = apiKey;
    return;
  }

  if (auth.type === 'basic') {
    const username = credentialString(credential, ['username']);
    const password = credentialString(credential, ['password']);
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
}

function credentialString(credential: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(credential[key]);
    if (value) return value;
  }
  throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', `credential is missing ${keys[0]}`);
}

function renderStringRecord(
  value: Record<string, string>,
  scope: TemplateScope,
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    rendered[key] = renderTemplateString(raw, scope);
  }
  return rendered;
}

function renderTemplateValue(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') return renderTemplateString(value, scope);
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        renderTemplateValue(item, scope),
      ]),
    );
  }
  return value;
}

function renderTemplateString(value: string, scope: TemplateScope): string {
  return value.replace(TEMPLATE_TOKEN, (_match, mustache: string | undefined, brace: string | undefined) => {
    const key = mustache ?? brace ?? '';
    const resolved = resolveTemplatePath(scope, key);
    if (resolved === undefined || resolved === null) {
      throw new AgentisError('VALIDATION_FAILED', `Missing integration template param: ${key}`);
    }
    return String(resolved);
  });
}

interface TemplateScope {
  params: Record<string, unknown>;
  credential: Record<string, unknown>;
  input: Record<string, unknown>;
}

function resolveTemplatePath(scope: TemplateScope, path: string): unknown {
  const explicitScope = path.split('.')[0];
  if (explicitScope === 'params' || explicitScope === 'credential' || explicitScope === 'input') {
    return getPath(scope[explicitScope], path.split('.').slice(1));
  }
  return getPath(scope.params, path.split('.'));
}

function getPath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
