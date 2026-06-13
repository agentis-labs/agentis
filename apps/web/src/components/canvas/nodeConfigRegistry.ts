export interface IntegrationManifestLite {
  id?: string;
  service: string;
  name: string;
  category?: string;
  description?: string;
  operations: readonly string[];
  operationContracts?: Record<string, {
    required?: readonly string[];
    requiredAny?: ReadonlyArray<readonly string[]>;
    aliases?: Record<string, readonly string[]>;
  }>;
  credentialSchema?: {
    type?: string;
    fields?: readonly string[];
    [key: string]: unknown;
  };
  auth?: {
    type?: string;
    [key: string]: unknown;
  };
  runtime?: string;
  builtin?: boolean;
  /** Logo id (one of the bundled connector logos) or absolute URL. */
  icon?: string;
  docsUrl?: string;
}

export interface NodeReadiness {
  ready: boolean;
  message: string | null;
}

export interface NodeConfigContext {
  integrations?: readonly IntegrationManifestLite[];
}

export interface NodeConfigMeta {
  label: string;
  reason: string;
}

export const NODE_CONFIG_META: Record<string, NodeConfigMeta> = {
  trigger: { label: 'Trigger', reason: 'Starts the workflow on demand, on a schedule, or from an incoming event.' },
  router: { label: 'Router', reason: 'Routes data into one or more branches based on explicit conditions or an LLM decision.' },
  merge: { label: 'Merge', reason: 'Joins parallel branches into one predictable downstream payload.' },
  wait: { label: 'Wait', reason: 'Pauses the run safely until the configured delay has elapsed.' },
  loop: { label: 'Loop', reason: 'Iterates over an array through a reusable child workflow.' },
  parallel: { label: 'Parallel', reason: 'Runs downstream branches concurrently and defines how their results are joined.' },
  subflow: { label: 'Subflow', reason: 'Runs a reusable workflow as a single step.' },
  transform: { label: 'Transform', reason: 'Reshapes data deterministically without spending LLM tokens.' },
  filter: { label: 'Filter', reason: 'Stops data that does not satisfy a deterministic condition.' },
  integration: { label: 'Integration', reason: 'Calls a connector operation with credentials only when that connector requires them.' },
  http_request: { label: 'HTTP request', reason: 'Calls a raw HTTP endpoint with templated inputs and retry controls.' },
  workflow_store: { label: 'Workflow store', reason: 'Reads or writes persistent state scoped to this workflow.' },
  workspace_store: { label: 'Workspace store', reason: 'Reads or writes state shared across workflows in this workspace.' },
  scratchpad: { label: 'Scratchpad', reason: 'Keeps temporary run-scoped values for later nodes.' },
  agent_task: { label: 'Agent task', reason: 'Routes a prompt to an agent that matches the requested capabilities.' },
  agent_session: { label: 'Agent session', reason: 'Runs a persistent agent session that can think, use tools, and resume work.' },
  extension_task: { label: 'Extension', reason: 'Runs a typed deterministic extension operation.' },
  agent_swarm: { label: 'Agent swarm', reason: 'Fans items out across agents and collects the results.' },
  dynamic_swarm: { label: 'Dynamic swarm', reason: 'Lets a planner decompose a goal into bounded parallel tasks.' },
  planner: { label: 'Planner', reason: 'Turns a goal into a bounded sequence of executable agent steps.' },
  evaluator: { label: 'Evaluator', reason: 'Scores an output against natural-language acceptance criteria.' },
  guardrails: { label: 'Guardrails', reason: 'Applies deterministic policy checks before data continues.' },
  knowledge: { label: 'Brain', reason: 'Retrieves relevant workspace knowledge for downstream work.' },
  artifact_collect: { label: 'Artifact collect', reason: 'Packages generated artifacts into a versioned collection.' },
  return_output: { label: 'Return output', reason: 'Declares the rendered result operators see after a run.' },
  artifact_save: { label: 'Save artifact', reason: 'Persists generated content as a workspace artifact.' },
  browser: { label: 'Browser', reason: 'Uses Chromium to render, navigate, extract, or capture web content.' },
  checkpoint: { label: 'Checkpoint', reason: 'Pauses the run until an operator reviews the work.' },
};

export function nodeConfigMeta(kind: string): NodeConfigMeta {
  return NODE_CONFIG_META[kind] ?? {
    label: humanizeIdentifier(kind || 'node'),
    reason: 'Configures how this workflow step behaves.',
  };
}

export function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function integrationNeedsCredential(manifest?: IntegrationManifestLite): boolean {
  const authType = manifest?.auth?.type ?? manifest?.credentialSchema?.type;
  return Boolean(authType && authType !== 'none');
}

export function evaluateNodeReadiness(config: unknown, context: NodeConfigContext = {}): NodeReadiness {
  const c = objectRecord(config);
  const kind = stringOf(c.kind);
  const missing = (message: string): NodeReadiness => ({ ready: false, message });
  const ready = (): NodeReadiness => ({ ready: true, message: null });

  switch (kind) {
    case 'trigger': {
      const triggerType = stringOf(c.triggerType) || 'manual';
      if (triggerType === 'cron') {
        return stringOf(c.schedule).trim() ? ready() : missing('Enter a cron schedule.');
      }
      if (triggerType === 'persistent_listener') {
        const parsed = schemas.listenerConfigSchema.safeParse(c.listenerConfig);
        if (!parsed.success) {
          return missing(listenerIssueMessage(parsed.error.issues[0]?.message));
        }
      }
      return ready();
    }
    case 'integration': {
      const integrationId = stringOf(c.integrationId);
      if (!integrationId) return missing('Choose an integration.');
      if (!stringOf(c.operationId)) return missing('Choose an integration operation.');
      const manifest = context.integrations?.find((item) => item.service === integrationId || item.id === integrationId);
      if (integrationNeedsCredential(manifest) && !stringOf(c.credentialId)) {
        return missing(`Bind a ${manifest?.name ?? humanizeIdentifier(integrationId)} credential.`);
      }
      const contract = manifest?.operationContracts?.[stringOf(c.operationId)];
      const missingRequired = firstMissingContractInput(objectRecord(c.inputs), contract);
      if (missingRequired) return missing(missingRequired);
      return ready();
    }
    case 'http_request':
      if (!stringOf(c.method)) return missing('Choose an HTTP method.');
      return stringOf(c.url) ? ready() : missing('Enter the request URL.');
    case 'extension_task':
      if (!stringOf(c.extensionId) && !stringOf(c.extensionSlug)) return missing('Choose an extension.');
      return stringOf(c.operationName) ? ready() : missing('Choose an extension operation.');
    case 'transform':
      return stringOf(c.expression) ? ready() : missing('Enter a transform expression.');
    case 'filter':
      return stringOf(c.condition) ? ready() : missing('Enter a filter condition.');
    case 'router':
      return nonEmptyArray(c.branches) ? ready() : missing('Add at least one branch.');
    case 'subflow':
      return stringOf(c.workflowId) ? ready() : missing('Choose a reusable workflow.');
    case 'scratchpad':
      return stringOf(c.key).trim() ? ready() : missing('Enter a scratchpad key.');
    case 'agent_task':
    case 'agent_session':
      return stringOf(c.prompt).trim() ? ready() : missing('Write the agent prompt.');
    case 'dynamic_swarm':
      if (!stringOf(c.goal).trim()) return missing('Describe the swarm goal.');
      if (!stringOf(c.outputKey)) return missing('Enter an output key.');
      return typeof c.maxTasks === 'number' && c.maxTasks >= 1 ? ready() : missing('Set max tasks to at least 1.');
    case 'planner':
      return stringOf(c.goal).trim() ? ready() : missing('Describe the planning goal.');
    case 'wait':
      return typeof c.delayMs === 'number' && c.delayMs >= 0 ? ready() : missing('Enter a non-negative wait duration.');
    case 'workflow_store':
    case 'workspace_store':
      return nonEmptyArray(c.operations) ? ready() : missing('Add at least one store operation.');
    case 'evaluator':
      if (!stringOf(c.targetPath)) return missing('Choose the value to evaluate.');
      return stringOf(c.criteria) ? ready() : missing('Write the evaluation criteria.');
    case 'guardrails':
      return nonEmptyArray(c.rules) ? ready() : missing('Add at least one guardrail rule.');
    case 'loop':
      if (!stringOf(c.itemsExpression)) return missing('Enter the items expression.');
      if (!stringOf(c.bodyWorkflowId)) return missing('Choose the loop body workflow.');
      return stringOf(c.outputArrayKey) ? ready() : missing('Enter an output array key.');
    case 'browser':
      if (stringOf(c.operation) === 'serve_html') return ready();
      return stringOf(c.url) || stringOf(c.html) || stringOf(c.htmlPath)
        ? ready()
        : missing('Enter a URL, HTML path, or inline HTML.');
    default:
      return ready();
  }
}

function listenerIssueMessage(issue?: string): string {
  if (!issue || issue === 'Required') return 'Configure the listener source.';
  if (issue.includes('extensionId or extensionSlug')) return 'Choose a listener-source extension.';
  return `Listener: ${issue}`;
}

function firstMissingContractInput(
  inputs: Record<string, unknown>,
  contract: NonNullable<IntegrationManifestLite['operationContracts']>[string] | undefined,
): string | null {
  if (!contract) return null;
  for (const field of contract.required ?? []) {
    if (!hasContractValue(inputs, field, contract.aliases?.[field] ?? [])) {
      return `Fill ${humanizeIdentifier(field)}.`;
    }
  }
  for (const group of contract.requiredAny ?? []) {
    if (!group.some((field) => hasContractValue(inputs, field, contract.aliases?.[field] ?? []))) {
      return `Fill one of: ${group.map(humanizeIdentifier).join(', ')}.`;
    }
  }
  return null;
}

function hasContractValue(
  inputs: Record<string, unknown>,
  field: string,
  aliases: readonly string[],
): boolean {
  for (const key of [field, ...aliases]) {
    const value = inputs[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return true;
  }
  return false;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
import { schemas } from '@agentis/core';
