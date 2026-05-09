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

export function registerAllTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registerInspectTools(registry, deps);
  registerRunTools(registry, deps);
  registerBuildTools(registry, deps);
  registerDataTools(registry, deps);
  registerEnvironmentTools(registry, deps);
  registerMemoryTools(registry, deps);
}

export type { ToolHandlerDeps } from './deps.js';
