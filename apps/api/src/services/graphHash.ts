/**
 * Workflow graph fingerprint (NATIVE-ADVANCEMENT Task 2, divergence-fingerprint
 * framing — see docs/NATIVE-ADVANCEMENT.md Q2).
 *
 * SHA-256 over the behaviour-significant canonical form of a graph. Used to:
 *  - detect save/run divergence (the run executed a different graph than what
 *    is now stored), and
 *  - let the canvas detect unsaved local edits by comparing its locally-derived
 *    hash to the server's `contentHash`.
 *
 * This is NOT a tamper/security boundary. The hashing lives here (not in
 * @agentis/core) so core stays browser-safe with no `node:crypto` import.
 */

import { createHash } from 'node:crypto';
import { canonicalizeGraph, type WorkflowGraph } from '@agentis/core';

/** Stable SHA-256 hex fingerprint of a workflow graph. */
export function hashWorkflowGraph(graph: WorkflowGraph): string {
  return createHash('sha256').update(canonicalizeGraph(graph)).digest('hex');
}
