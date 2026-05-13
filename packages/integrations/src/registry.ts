import { ConnectorRegistry } from './ConnectorRegistry.js';
import { httpRequestConnector, webhookSendConnector } from './connectors/http.js';
import {
  githubConnector,
  genericHttpConnector,
  gmailConnector,
  googleSheetsConnector,
  slackConnector,
} from './connectors/apiConnectors.js';
import { builtinIntegrationManifests } from './manifests.js';
import type { ConnectorModule } from './types.js';

const implementedConnectors: ConnectorModule[] = [
  httpRequestConnector,
  webhookSendConnector,
  slackConnector,
  gmailConnector,
  githubConnector,
  googleSheetsConnector,
];

const manifestOnlyConnectors: ConnectorModule[] = builtinIntegrationManifests
  .filter((manifest) => manifest.runtime === 'manifest_only')
  .map((manifest) => genericHttpConnector(manifest.service, manifest.operations));

export const builtinConnectors: ConnectorModule[] = [...implementedConnectors, ...manifestOnlyConnectors];
export const defaultConnectorRegistry = new ConnectorRegistry(builtinConnectors);
