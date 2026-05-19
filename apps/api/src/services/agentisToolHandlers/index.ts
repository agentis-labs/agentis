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
import { registerDataTools } from './data.js';
import { registerEnvironmentTools } from './environment.js';
import { registerMemoryTools } from './memory.js';
import { registerAgentTools } from './agent.js';
import { registerAppTools, type AppToolDeps } from './app.js';
import { registerEphemeralTools } from './ephemeral.js';

export function registerAllTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registerInspectTools(registry, deps);
  registerRunTools(registry, deps);
  registerBuildTools(registry, deps);
  registerAgentTools(registry, deps);
  registerDataTools(registry, deps);
  registerEnvironmentTools(registry, deps);
  registerMemoryTools(registry, deps);
  registerEphemeralTools(registry, deps);
  // App-layer tools are optional — only registered if the bootstrap passed
  // the AppResults/AppThread services. Keeps tests that don't need them
  // free to assemble a minimal registry.
  if (isAppToolDeps(deps)) registerAppTools(registry, deps);
}

function isAppToolDeps(deps: ToolHandlerDeps): deps is AppToolDeps {
  return Boolean((deps as AppToolDeps).appResults) && Boolean((deps as AppToolDeps).appThread);
}

export type { ToolHandlerDeps } from './deps.js';
export { APP_THREAD_TOOL_IDS } from './app.js';
