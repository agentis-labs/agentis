/**
 * Workflow test-case generator — SWIFT Iterate (SWIFT-WORKFLOW-QUALITY-10X §2-I).
 *
 * Mechanically derives edge/adversarial fixtures from `graph.inputContract`:
 * each optional field absent, required strings empty, arrays [], numbers 0 —
 * the messy-input battery every workflow should survive BEFORE a trigger arms.
 * Generated cases land as `origin:'generated'` and are NON-GATING until the
 * building agent verifies and keeps them (a hallucinated fixture must never
 * fail a gate falsely). Pure module — no LLM, no I/O.
 */

import { randomUUID } from 'node:crypto';
import type { WorkflowGraph } from '@agentis/core';

export interface WorkflowTestCase {
  id: string;
  name: string;
  kind: 'happy' | 'edge' | 'adversarial' | 'regression';
  inputs: Record<string, unknown>;
  assertions: Array<{ nodeId: string; expr: string; message?: string }>;
  /** Expected outcome when the case runs with a spec present. */
  expectOutcome?: { verdict: 'accomplished' | 'partial' | 'hollow' | 'failed_checks'; expectDeficiencies?: string[] };
  origin: 'authored' | 'generated' | 'from_failed_run';
}

interface ContractField {
  key: string;
  type?: string;
  required?: boolean;
  example?: unknown;
}

function contractFields(graph: WorkflowGraph): ContractField[] {
  const contract = (graph as { inputContract?: { fields?: ContractField[] } }).inputContract;
  return Array.isArray(contract?.fields) ? contract!.fields! : [];
}

function exampleValue(field: ContractField): unknown {
  if (field.example !== undefined) return field.example;
  switch (field.type) {
    case 'number': return 42;
    case 'boolean': return true;
    case 'array': return ['sample'];
    case 'object': return { sample: true };
    default: return `sample ${field.key}`;
  }
}

/** A plausible happy-path input from the contract (baseline for mutations). */
export function happyInputs(graph: WorkflowGraph): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const field of contractFields(graph)) inputs[field.key] = exampleValue(field);
  return inputs;
}

/**
 * The mechanical battery. Returns [] when the graph has no input contract —
 * there is nothing to mutate (the agent should author cases by hand).
 */
export function generateEdgeCases(graph: WorkflowGraph): WorkflowTestCase[] {
  const fields = contractFields(graph);
  if (fields.length === 0) return [];
  const base = happyInputs(graph);
  const cases: WorkflowTestCase[] = [
    {
      id: randomUUID(),
      name: 'happy path (from input contract)',
      kind: 'happy',
      inputs: base,
      assertions: [],
      expectOutcome: { verdict: 'accomplished' },
      origin: 'generated',
    },
  ];
  for (const field of fields) {
    // Absent field — required ⇒ the workflow should fail GRACEFULLY (a verdict
    // failure or a validation stop), never a hollow "success".
    const withoutField = { ...base };
    delete withoutField[field.key];
    cases.push({
      id: randomUUID(),
      name: `missing ${field.required ? 'required' : 'optional'} "${field.key}"`,
      kind: field.required ? 'adversarial' : 'edge',
      inputs: withoutField,
      assertions: [],
      ...(field.required ? { expectOutcome: { verdict: 'failed_checks' as const } } : {}),
      origin: 'generated',
    });
    // Hollow variants per type.
    if (field.type === 'string' || field.type === undefined) {
      cases.push({
        id: randomUUID(),
        name: `empty "${field.key}"`,
        kind: 'edge',
        inputs: { ...base, [field.key]: '' },
        assertions: [],
        origin: 'generated',
      });
    }
    if (field.type === 'array') {
      cases.push({
        id: randomUUID(),
        name: `empty array "${field.key}"`,
        kind: 'edge',
        inputs: { ...base, [field.key]: [] },
        assertions: [],
        origin: 'generated',
      });
    }
    if (field.type === 'number') {
      cases.push({
        id: randomUUID(),
        name: `zero "${field.key}"`,
        kind: 'edge',
        inputs: { ...base, [field.key]: 0 },
        assertions: [],
        origin: 'generated',
      });
    }
  }
  return cases;
}

/** Read the persisted suite; the legacy single `workflowTest` pin becomes the
 *  first happy case so nothing regresses. */
export function readWorkflowTests(settings: unknown): WorkflowTestCase[] {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  const suite = Array.isArray(s.workflowTests) ? (s.workflowTests as WorkflowTestCase[]) : [];
  const legacy = s.workflowTest as { inputs?: Record<string, unknown>; assertions?: Array<{ nodeId: string; expr: string; message?: string }> } | undefined;
  if (legacy && (legacy.inputs || legacy.assertions) && !suite.some((c) => c.id === 'legacy-pin')) {
    return [
      {
        id: 'legacy-pin',
        name: 'pinned test (legacy)',
        kind: 'happy',
        inputs: legacy.inputs ?? {},
        assertions: legacy.assertions ?? [],
        origin: 'authored',
      },
      ...suite,
    ];
  }
  return suite;
}
