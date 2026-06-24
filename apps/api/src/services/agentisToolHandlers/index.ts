/**
 * Agentis tool handlers — Plane 2 family registry.
 *
 * Each family file exports a `register(registry, deps)` function that wires
 * its tools into AgentisToolRegistry. The bootstrap calls them in a fixed
 * order so the registry is fully populated before any handler can execute.
 */

import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { registerInspectTools } from './inspect.js';
import { registerRunTools } from './run.js';
import { registerBuildTools } from './build.js';
import { registerEnvironmentTools } from './environment.js';
import { registerAgentTools } from './agent.js';
import { registerEphemeralTools } from './ephemeral.js';
import { registerCapabilityTools } from './capability.js';
import { registerTaskSpineTools } from './taskSpine.js';
import { registerChannelTools } from './channel.js';
import { registerBrowserTools } from './browser.js';
import { registerMcpBridgeTools } from './mcp.js';
import { registerAppDataTools } from './appData.js';

export function registerAllTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registerInspectTools(registry, deps);
  registerRunTools(registry, deps);
  registerBuildTools(registry, deps);
  registerAgentTools(registry, deps);
  registerEnvironmentTools(registry, deps);
  registerEphemeralTools(registry, deps);
  registerCapabilityTools(registry, deps);
  registerTaskSpineTools(registry, deps);
  registerChannelTools(registry, deps);
  registerBrowserTools(registry, deps);
  registerMcpBridgeTools(registry, deps);
  registerAppDataTools(registry, deps);
}

export type { ToolHandlerDeps } from './deps.js';
