/**
 * Custom integrations client — workspace-authored connectors.
 *
 * Mirrors `/v1/integrations` (apps/api/src/routes/integrations.ts). A custom
 * integration is a declarative HTTP connector: name + auth + a set of
 * operations (method/url/body templates). It's stored as a Library package and
 * shows up in the catalog alongside built-ins, usable from any integration node.
 */
import { api } from './api';
import type { IntegrationManifestLite } from '../components/canvas/nodeConfigRegistry';

export type IntegrationAuthType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface IntegrationOperationInput {
  name: string;
  method: HttpMethod;
  urlTemplate: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  bodyTemplate?: unknown;
  responseMode?: 'auto' | 'json' | 'text';
}

export interface CustomIntegrationInput {
  service: string;
  name: string;
  category?: string;
  description?: string;
  auth?: { type: IntegrationAuthType; headerName?: string; queryParamName?: string };
  operationSpecs: IntegrationOperationInput[];
  icon?: string;
  docsUrl?: string;
}

export function listIntegrations() {
  return api<{ integrations: IntegrationManifestLite[] }>('/v1/integrations');
}

export function createIntegration(input: CustomIntegrationInput) {
  return api<{ integration: IntegrationManifestLite }>('/v1/integrations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateIntegration(id: string, input: CustomIntegrationInput) {
  return api<{ integration: IntegrationManifestLite }>(`/v1/integrations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteIntegration(id: string) {
  return api<{ ok: true }>(`/v1/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function testIntegration(
  id: string,
  body: { operation: string; params?: Record<string, unknown>; credential?: Record<string, unknown> | null },
) {
  return api<{ ok: true; output: unknown }>(`/v1/integrations/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
