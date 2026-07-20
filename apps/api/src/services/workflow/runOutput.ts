/**
 * Terminal output of a settled run, read back from its persisted state.
 *
 * A chain link used to hand its dependent only IDs and a status string, so every
 * downstream workflow had to re-read the upstream run itself to find out what
 * actually happened — the data was there, just not passed. This reads the
 * declared output surface (the `return_output` / `isOutput` nodes, else the last
 * node) out of a run's own graph snapshot, so a link can carry real values.
 */

import { unwrapReturnEnvelope } from './workflowVerdict.js';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';

/**
 * Cap on the serialized output carried through a chain link. Queue rows are
 * written on every start and read on every sweep; an unbounded blob here turns
 * a chain into a copy of the upstream's entire working set. Past the cap the
 * dependent gets a marker and re-reads the run itself, which is exactly the old
 * behaviour — degraded, not broken.
 */
export const MAX_CHAINED_OUTPUT_BYTES = 64 * 1024;

export interface ChainedOutput {
  output: Record<string, unknown> | null;
  /** Set when the output was dropped rather than passed, with the reason. */
  omitted?: 'too_large' | 'unavailable';
}

/** Read the declared terminal output of a settled run. Never throws. */
export function readRunTerminalOutput(
  graphSnapshot: unknown,
  runState: unknown,
): ChainedOutput {
  const graph = graphSnapshot as WorkflowGraph | null | undefined;
  const state = runState as WorkflowRunState | null | undefined;
  if (!graph?.nodes?.length || !state?.nodeStates) return { output: null, omitted: 'unavailable' };

  const declared = graph.nodes.filter((node) => {
    const config = node.config as { kind?: string; isOutput?: boolean } | undefined;
    return config?.kind === 'return_output' || config?.isOutput === true;
  });
  // Same surface rule the dry-run trace uses: declared outputs when present,
  // otherwise the last node — so a chain sees what a test run showed.
  const surface = declared.length > 0 ? declared : graph.nodes.slice(-1);

  const output: Record<string, unknown> = {};
  for (const node of surface) {
    const nodeOutput = (state.nodeStates as Record<string, { output?: unknown }>)[node.id]?.output;
    if (nodeOutput && typeof nodeOutput === 'object' && !Array.isArray(nodeOutput)) {
      Object.assign(output, unwrapReturnEnvelope(nodeOutput as Record<string, unknown>));
    }
  }
  if (Object.keys(output).length === 0) return { output: null, omitted: 'unavailable' };

  try {
    if (JSON.stringify(output).length > MAX_CHAINED_OUTPUT_BYTES) {
      return { output: null, omitted: 'too_large' };
    }
  } catch {
    return { output: null, omitted: 'unavailable' }; // circular / non-serializable
  }
  return { output };
}
