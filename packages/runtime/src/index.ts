/**
 * Runtime package seam.
 *
 * Agentis apps run inside Agentis itself. This package is the stable lifecycle
 * contract for that runtime while the current implementation is still hosted by
 * `apps/api`. Later phases can move the composition root here without changing
 * CLI/API/test callers.
 */

export interface AgentisRuntimeStartResult<THttpServer = unknown> {
  url: string;
  httpServer: THttpServer;
}

export interface AgentisRuntimeHandle<TStartResult = AgentisRuntimeStartResult> {
  start(): Promise<TStartResult>;
  stop(): Promise<void>;
}

export type AgentisRuntimeBootstrap<THandle extends AgentisRuntimeHandle = AgentisRuntimeHandle> = (
  envSource?: Record<string, string | undefined>,
) => Promise<THandle>;

export const AGENTIS_RUNTIME_PACKAGE = '@agentis/runtime';



