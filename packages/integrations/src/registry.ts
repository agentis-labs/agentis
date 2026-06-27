import { ConnectorRegistry } from './ConnectorRegistry.js';
import { httpRequestConnector, webhookSendConnector } from './connectors/http.js';
import {
  agentMailConnector,
  githubConnector,
  genericHttpConnector,
  gmailConnector,
  googleSheetsConnector,
  slackConnector,
} from './connectors/apiConnectors.js';
import { builtinIntegrationManifests } from './manifests.js';
import { SERVICE_TEMPLATES, templatedHttpConnector } from './connectors/templatedConnectors.js';
import type { ConnectorModule } from './types.js';

const implementedConnectors: ConnectorModule[] = [
  httpRequestConnector,
  webhookSendConnector,
  slackConnector,
  gmailConnector,
  agentMailConnector,
  githubConnector,
  googleSheetsConnector,
];

// `manifest_only` services get a real, working connector when we have a per-service
// template (renders URL + auth from a bound credential); otherwise they fall back
// to the generic HTTP connector (caller must supply params.url / credential.baseUrl).
const manifestOnlyConnectors: ConnectorModule[] = builtinIntegrationManifests
  .filter((manifest) => manifest.runtime === 'manifest_only')
  .map((manifest) => {
    const template = SERVICE_TEMPLATES[manifest.service];
    return template
      ? templatedHttpConnector(manifest.service, manifest.operations, template)
      : genericHttpConnector(manifest.service, manifest.operations);
  });

export const builtinConnectors: ConnectorModule[] = [...implementedConnectors, ...manifestOnlyConnectors];
export const defaultConnectorRegistry = new ConnectorRegistry(builtinConnectors);

// ── Honest catalog (masterplan 2.2) ──────────────────────────────────────────
// The platform advertises ~95 connectors but only the hand-written + templated
// ones run out of the box; the rest fall back to a generic HTTP connector that
// THROWS unless the caller supplies a URL. Surfacing that distinction stops the
// UI from presenting a connector as ready when it would fail on first use.

export type ConnectorReadiness = 'runnable' | 'needs_setup';

const IMPLEMENTED_SERVICES = new Set(implementedConnectors.map((connector) => connector.service));

/**
 * Whether a connector runs out of the box (hand-written or per-service template)
 * or needs operator setup first (generic HTTP fallback — requires a URL/baseUrl).
 */
export function connectorReadiness(service: string): ConnectorReadiness {
  if (IMPLEMENTED_SERVICES.has(service) || Boolean(SERVICE_TEMPLATES[service])) return 'runnable';
  return 'needs_setup';
}

export interface ConnectorCatalogEntry {
  service: string;
  name: string;
  category: string;
  description: string;
  operations: string[];
  readiness: ConnectorReadiness;
}

/** Every advertised connector tagged runnable vs needs-setup, sorted by service. */
export function connectorCatalog(): ConnectorCatalogEntry[] {
  return builtinIntegrationManifests
    .map((manifest) => ({
      service: manifest.service,
      name: manifest.name,
      category: manifest.category,
      description: manifest.description,
      operations: manifest.operations,
      readiness: connectorReadiness(manifest.service),
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
}
