/**
 * harnessImport/registry — the L1 discovery spine (AGENT-TRANSITION §3).
 *
 * Collects the per-harness source modules, runs them against the local machine,
 * and merges in runtime detection (binary path + model) so a discovered agent
 * is immediately runnable once imported. Adding a harness = adding one source
 * module to `HARNESS_IMPORT_SOURCES` — the spine never changes.
 */

import os from 'node:os';
import { detectHarnesses, type HarnessDetectionResult } from '../harnessProbe.js';
import type { DiscoverCtx, DiscoveredAgent, HarnessImportSource, ImportInputs } from './types.js';
import { claudeCodeSource } from './sources/claudeCode.js';
import { hermesSource } from './sources/hermes.js';
import { codexSource } from './sources/codex.js';
import { cursorSource } from './sources/cursor.js';

export const HARNESS_IMPORT_SOURCES: HarnessImportSource[] = [
  claudeCodeSource,
  hermesSource,
  codexSource,
  cursorSource,
];

export interface DiscoverAgentsOptions {
  env?: NodeJS.ProcessEnv;
  /** Optional project cwd to also scan for project-level agents/rules. */
  cwd?: string | null;
  /** Pre-computed detection (avoids re-probing). When omitted, we detect. */
  detections?: HarnessDetectionResult[];
}

function ctxOf(opts: DiscoverAgentsOptions): DiscoverCtx {
  const env = opts.env ?? process.env;
  return { env, home: env.USERPROFILE || env.HOME || os.homedir(), cwd: opts.cwd ?? null };
}

function findSource(adapterType: string): HarnessImportSource | undefined {
  return HARNESS_IMPORT_SOURCES.find((s) => s.adapterType === adapterType);
}

/** Enumerate every external agent discoverable on this machine. */
export async function discoverAgents(opts: DiscoverAgentsOptions = {}): Promise<DiscoveredAgent[]> {
  const ctx = ctxOf(opts);
  const detections = opts.detections ?? await detectHarnesses(ctx.env);
  const detByType = new Map(detections.map((d) => [d.adapterType, d]));

  const out: DiscoveredAgent[] = [];
  for (const source of HARNESS_IMPORT_SOURCES) {
    let discovered: DiscoveredAgent[] = [];
    try {
      discovered = source.discover(ctx);
    } catch {
      discovered = [];
    }
    const det = detByType.get(source.adapterType);
    for (const agent of discovered) {
      // Agent-specific config wins; detection supplies the binary path + model.
      if (det?.config) agent.config = { ...det.config, ...agent.config };
      if (!agent.detectedModel && det?.detectedModel) agent.detectedModel = det.detectedModel;
      out.push(agent);
    }
  }

  // Remote runtimes (OpenClaw gateway / HTTP endpoint) keep no local files and
  // expose no roster protocol, so we cannot enumerate their agents. When one is
  // CONFIGURED, surface it as a single identity-only importable agent: importing
  // it makes the endpoint an Agentis-owned, runtime-swappable agent (Track R).
  // This is honest — it does not invent a roster the gateway does not provide.
  for (const det of detections) {
    if ((det.adapterType === 'openclaw' || det.adapterType === 'http') && det.status === 'found') {
      out.push({
        adapterType: det.adapterType,
        externalId: `${det.adapterType}:remote`,
        name: det.harness,
        role: null,
        persona: null,
        detectedModel: det.detectedModel ?? null,
        config: det.config ? { ...det.config } : {},
        origin: { harness: det.harness, rootPath: det.detail ?? det.harness },
        summary: { memoryFiles: 0, workspaceFiles: 0, agentFiles: 0, skills: 0 },
      });
    }
  }

  return out;
}

/** Read the full identity + memory inputs for one discovered agent. */
export function readAgentInputs(agent: DiscoveredAgent, opts: DiscoverAgentsOptions = {}): ImportInputs {
  const source = findSource(agent.adapterType);
  if (!source) return { agent, files: [], skills: [] };
  try {
    return source.read(agent, ctxOf(opts));
  } catch {
    return { agent, files: [], skills: [] };
  }
}
