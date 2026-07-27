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

// A `manifest_only` service with no per-service template falls back to the
// generic HTTP connector: it auto-attaches the bound credential as a bearer
// token (http.ts#applyCredential), so a text-only authenticated call genuinely
// works if the caller supplies params.url — but services whose REAL posting
// flow needs binary/multipart upload (an image attached to a tweet, a LinkedIn
// asset, an Instagram media container) can never be expressed this way. Give
// those an honest, specific reason instead of a generic "supply a URL" dead
// end (INTEGRATION-CEILING-10X §0 — never claim more than the platform does).
const GENERIC_CONNECTOR_HINTS: Record<string, string> = {
  twitter_x: 'No built-in X connector exists yet — this generic path sends plain JSON to whatever endpoint you supply as params.url and will authenticate with your OAuth credential, but X requires a separate multipart media-upload step (POST /2/tweets with media_ids) that this path cannot express; text-only posts may work if you supply the exact endpoint yourself.',
  linkedin: 'No built-in LinkedIn connector exists yet — this generic path sends plain JSON to whatever endpoint you supply as params.url and will authenticate with your OAuth credential, but LinkedIn requires a separate binary asset-upload step (registerUpload + PUT bytes) that this path cannot express; text-only posts may work if you supply the exact endpoint yourself.',
  instagram: 'No built-in Instagram connector exists yet — its Graph API requires a container-based publish flow (create a media container referencing a hosted image URL, then publish that container) that this generic JSON path cannot express at all.',
};

const manifestOnlyConnectors: ConnectorModule[] = builtinIntegrationManifests
  .filter((manifest) => manifest.runtime === 'manifest_only')
  .map((manifest) => {
    const template = SERVICE_TEMPLATES[manifest.service];
    return template
      ? templatedHttpConnector(manifest.service, manifest.operations, template)
      : genericHttpConnector(manifest.service, manifest.operations, GENERIC_CONNECTOR_HINTS[manifest.service]);
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
  /**
   * The manifest's declared credential type ('bearer_token', 'oauth2', 'none', …).
   * Callers that ask "is this connector actually usable right now?" need it to
   * tell a connector that is MISSING its credential from one that never needed
   * one (`none`, e.g. http_request), which is usable with an empty vault.
   */
  authType: string;
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
      authType: typeof manifest.credentialSchema?.type === 'string' ? manifest.credentialSchema.type : 'unknown',
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
}



