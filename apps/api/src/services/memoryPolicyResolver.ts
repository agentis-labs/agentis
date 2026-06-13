/**
 * memoryPolicyResolver — decides, per task run, what the run may write to the
 * Brain BEFORE any text is mined. This is the highest-leverage half of the
 * formation fix: a daily digest is structurally transient, so it is gated to
 * `episodic_only` (one outcome marker) and can never form pattern atoms,
 * regardless of how "insightful" its prose reads.
 *
 * Resolution order (first decisive wins):
 *   1. Explicit node config — `node.config.memoryPolicy: 'form'|'episodic_only'|'none'`.
 *   2. Source surface — operator chat is always allowed to `form` (a stated rule
 *      is durable regardless of output shape); knowledge ingest is evidence, so
 *      it is gated to `episodic_only`.
 *   3. Node/agent role — digest/notifier/reporter roles default to episodic_only.
 *   4. Output shape — a homogeneous list of rows or a rendered document is
 *      transient work product ⇒ episodic_only.
 *   5. Default — `form`.
 *
 * PACER note: the policy decides WHETHER a run may form memory; `brainPacer`
 * decides WHAT KIND the resulting atoms are and how they decay. They are
 * complementary — the policy is the gate, PACER is the router.
 */

import { classifyOutputShape, type MemoryWritePolicy } from './brainFormation.js';
import type { SourceSurface } from './brainPacer.js';

export interface MemoryPolicyInput {
  /** Explicit override from node config, if the operator set one. */
  explicitPolicy?: unknown;
  /** Where the content came from (Phase 2 — source-aware routing). */
  surface?: SourceSurface | null;
  /** Workflow node kind (e.g. 'agent_task'). */
  nodeKind?: string | null;
  /** Node title — used for the transient-role heuristic. */
  nodeTitle?: string | null;
  /** Agent role, if the node is bound to an agent with a role. */
  agentRole?: string | null;
  /** The raw task output. */
  output?: unknown;
}

const VALID: ReadonlySet<string> = new Set(['form', 'episodic_only', 'none']);

/** Words that mark a transient, deliverable-producing task. */
const TRANSIENT_ROLE = /\b(digest|newsletter|notifier?|notification|report(er|ing)?|broadcast|announce(ment)?|summariz(e|er)|recap|round-?up|bulletin|alert)\b/i;

export function resolveMemoryPolicy(input: MemoryPolicyInput): { policy: MemoryWritePolicy; reason: string } {
  // 1. Explicit operator override.
  if (typeof input.explicitPolicy === 'string' && VALID.has(input.explicitPolicy)) {
    return { policy: input.explicitPolicy as MemoryWritePolicy, reason: 'node_config' };
  }

  // 2. Source surface (Phase 2). A human stating a rule/preference in chat is
  // durable knowledge no matter how short or list-like it reads, so operator
  // chat bypasses the output-shape gate. Knowledge ingest is evidence by
  // definition (PACER-E/R) and must stay cold — never mined for pattern atoms.
  if (input.surface === 'operator_chat' || input.surface === 'agent_reflection') {
    return { policy: 'form', reason: `surface:${input.surface}` };
  }
  if (input.surface === 'knowledge_ingest' || input.surface === 'session_conversation') {
    return { policy: 'episodic_only', reason: `surface:${input.surface}` };
  }

  // 3. Transient role/title.
  const roleText = `${input.agentRole ?? ''} ${input.nodeTitle ?? ''}`;
  if (TRANSIENT_ROLE.test(roleText)) {
    return { policy: 'episodic_only', reason: 'transient_role' };
  }

  // 4. Output shape.
  const shape = classifyOutputShape(input.output);
  if (shape === 'list_rows' || shape === 'document') {
    return { policy: 'episodic_only', reason: `output_shape:${shape}` };
  }
  if (shape === 'empty') {
    return { policy: 'none', reason: 'empty_output' };
  }

  // 5. Default.
  return { policy: 'form', reason: 'default' };
}
