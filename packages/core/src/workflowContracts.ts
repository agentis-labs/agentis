import type { WorkflowContract, WorkflowGraph } from './types/workflow.js';

type ContractField = WorkflowContract['fields'][number];

/**
 * Read a workflow contract in Agentis' canonical field DSL. Older agents often
 * emitted JSON Schema because graph validation previously let unknown shapes
 * pass through. Accept that legacy shape at read time, but always return the
 * canonical representation used by the compiler and runtime.
 */
export function workflowContractFields(value: unknown): ContractField[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const contract = value as Record<string, unknown>;
  if (Array.isArray(contract.fields)) {
    return contract.fields.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const field = raw as Record<string, unknown>;
      const key = typeof field.key === 'string' ? field.key.trim() : '';
      if (!key) return [];
      const type = canonicalType(field.type);
      return [{
        key,
        type,
        ...(field.required === true ? { required: true } : {}),
        ...(typeof field.description === 'string' && field.description.trim() ? { description: field.description.trim() } : {}),
        ...(typeof field.schema === 'string' && field.schema.trim() ? { schema: field.schema } : {}),
      } satisfies ContractField];
    });
  }

  const properties = contract.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(contract.required) ? contract.required.filter((key): key is string => typeof key === 'string') : []);
  return Object.entries(properties as Record<string, unknown>).map(([key, raw]) => {
    const property = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const nested = property.type === 'object' || property.type === 'array' ? JSON.stringify(property) : undefined;
    return {
      key,
      type: canonicalType(property.type),
      ...(required.has(key) ? { required: true } : {}),
      ...(typeof property.description === 'string' && property.description.trim() ? { description: property.description.trim() } : {}),
      ...(nested ? { schema: nested } : {}),
    } satisfies ContractField;
  });
}

export function canonicalWorkflowContract(value: unknown): WorkflowContract | undefined {
  const fields = workflowContractFields(value);
  return fields.length > 0 ? { fields } : undefined;
}

/** Convert legacy JSON-Schema contracts without changing any workflow intent. */
export function canonicalizeWorkflowGraphContracts(graph: WorkflowGraph): { graph: WorkflowGraph; changed: boolean } {
  const inputContract = canonicalWorkflowContract((graph as { inputContract?: unknown }).inputContract);
  const outputContract = canonicalWorkflowContract((graph as { outputContract?: unknown }).outputContract);
  const inputChanged = Boolean(graph.inputContract && JSON.stringify(graph.inputContract) !== JSON.stringify(inputContract));
  const outputChanged = Boolean(graph.outputContract && JSON.stringify(graph.outputContract) !== JSON.stringify(outputContract));
  if (!inputChanged && !outputChanged) return { graph, changed: false };
  const next = { ...graph };
  if (graph.inputContract) next.inputContract = inputContract;
  if (graph.outputContract) next.outputContract = outputContract;
  return { graph: next, changed: true };
}

function canonicalType(value: unknown): ContractField['type'] {
  const type = Array.isArray(value) ? value.find((item) => item !== 'null') : value;
  if (type === 'integer') return 'number';
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'array' || type === 'object'
    ? type
    : 'any';
}
