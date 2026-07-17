/**
 * computeSetupRequirements — the "nodes needing setup" a `.agentis` bundle needs
 * before its imported work can run. This is the first-class answer to "the import
 * didn't show me what I have to configure": credentials to reconnect, plugins that
 * must already be installed, and the external services the bundled workflows call
 * but carry no credential for.
 *
 * Pure over the manifest (no DB) so both preview and tests can call it.
 */

import type { WorkspaceBundleManifest, AppManifest } from '@agentis/core';

export interface SetupRequirements {
  credentials: Array<{ key: string; service: string; label: string }>;
  plugins: string[];
  connections: Array<{ service: string; reason: string }>;
}

/** Extract the integration/channel services a workflow graph reaches out to. */
function graphServices(graph: unknown): string[] {
  const g = graph as { nodes?: unknown } | null | undefined;
  const nodes = Array.isArray(g?.nodes) ? g!.nodes : [];
  const services: string[] = [];
  for (const node of nodes) {
    const config = (node as { config?: Record<string, unknown> } | null)?.config;
    if (!config) continue;
    if (config.kind === 'integration' && typeof config.service === 'string') services.push(config.service);
    else if (config.kind === 'channel' && typeof config.channel === 'string') services.push(config.channel);
  }
  return services;
}

function appServices(app: AppManifest): string[] {
  return app.workflows.flatMap((w) => graphServices(w.graph));
}

export function computeSetupRequirements(manifest: WorkspaceBundleManifest): SetupRequirements {
  const credentials = manifest.credentialSlots.map((slot) => ({ key: slot.key, service: slot.service, label: slot.label }));

  const plugins = new Set<string>();
  for (const app of manifest.apps) {
    for (const p of app.requiredPlugins) plugins.add(p);
    for (const p of app.identity.requiredPlugins ?? []) plugins.add(p);
  }

  // Services referenced by any bundled workflow (bare or in-App) that no credential
  // slot already covers — those are the connections the operator must set up.
  const coveredServices = new Set(manifest.credentialSlots.map((s) => s.service.toLowerCase()));
  const referenced = new Set<string>([
    ...manifest.workflows.flatMap((w) => graphServices(w.graph)),
    ...manifest.apps.flatMap(appServices),
  ]);
  const connections: SetupRequirements['connections'] = [];
  for (const service of referenced) {
    if (coveredServices.has(service.toLowerCase())) continue;
    connections.push({ service, reason: 'A bundled workflow calls this service but no credential travels with it.' });
  }

  return {
    credentials,
    plugins: [...plugins].sort((a, b) => a.localeCompare(b)),
    connections: connections.sort((a, b) => a.service.localeCompare(b.service)),
  };
}
