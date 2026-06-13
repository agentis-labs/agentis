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
