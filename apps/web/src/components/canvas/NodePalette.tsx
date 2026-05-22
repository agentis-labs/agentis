import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../lib/api';

/**
 * NodePalette — the canvas tool tray.
 *
 * Every entry's `type` field is the engine's `WorkflowNodeType` literal. The
 * drop handler in WorkflowCanvasPage uses that value directly as both the
 * node's `type` and its `config.kind`. So adding a new node here = adding a
 * new node to the engine taxonomy.
 *
 * The `defaults` object seeds the config when the node is dropped — keeps the
 * canvas usable without forcing users to fill every required field before
 * saving.
 */
export interface PaletteNodeType {
  type: string;
  label: string;
  glyph: string;
  description: string;
  /** Optional partial config seeded when the node is dropped. */
  defaults?: Record<string, unknown>;
}

export type PaletteTier = 'control' | 'data' | 'intel' | 'knowledge' | 'output' | 'human';

export interface PaletteSection {
  tier: PaletteTier;
  title: string;
  nodes: PaletteNodeType[];
}

const SECTIONS: PaletteSection[] = [
  {
    tier: 'control',
    title: 'Control flow',
    nodes: [
      { type: 'trigger',  label: 'Trigger',  glyph: '⚡', description: 'Manual, schedule, webhook, or persistent listener', defaults: { triggerType: 'manual' } },
      { type: 'router',   label: 'Router',   glyph: '⎇', description: 'Conditional branching (first/all/llm route)', defaults: { routingMode: 'first_match', branches: [] } },
      { type: 'merge',    label: 'Merge',    glyph: '⤳', description: 'Join multiple branches together', defaults: { requiredInputs: 'all' } },
      { type: 'wait',     label: 'Wait',     glyph: '⏲', description: 'Pause for a duration before resuming', defaults: { delayMs: 60_000 } },
      { type: 'loop',     label: 'Loop',     glyph: '↻', description: 'Iterate over an array with concurrency control', defaults: { maxConcurrency: 1, onIterationError: 'stop_all', outputArrayKey: 'results' } },
      { type: 'parallel', label: 'Parallel', glyph: '⫴', description: 'Fan out to N branches in parallel', defaults: { waitFor: 'all', onBranchError: 'fail_all', mergeStrategy: 'merge_keys' } },
      { type: 'subflow',  label: 'Subflow',  glyph: '▦', description: 'Embed another workflow inline', defaults: { inputMapping: {}, outputMapping: {} } },
    ],
  },
  {
    tier: 'data',
    title: 'Data & logic',
    nodes: [
      { type: 'transform',      label: 'Transform',      glyph: '⇄', description: 'Reshape data with a JS expression', defaults: { expression: 'input' } },
      { type: 'filter',         label: 'Filter',         glyph: '◓', description: 'Gate on a boolean expression', defaults: { condition: 'true' } },
      { type: 'integration',    label: 'Integration',    glyph: '⚙', description: 'Call a built-in connector (Slack, Gmail, …)', defaults: { inputs: {} } },
      { type: 'http_request',   label: 'HTTP Request',   glyph: '↗', description: 'Raw outbound HTTP call', defaults: { method: 'GET', url: '', headers: {} } },
      { type: 'workflow_store', label: 'Workflow Store', glyph: '◧', description: 'Read/write workflow-scoped persistent KV', defaults: { operations: [] } },
      { type: 'scratchpad',     label: 'Scratchpad',     glyph: '◈', description: 'Run-scoped ephemeral state', defaults: { operation: 'write', key: 'note' } },
    ],
  },
  {
    tier: 'intel',
    title: 'Intelligence',
    nodes: [
      { type: 'agent_task',  label: 'Agent',       glyph: '◎', description: 'Dispatch a task to a routed agent', defaults: { capabilityTags: [], prompt: '', inputKeys: [], outputKeys: [] } },
      { type: 'skill_task',  label: 'Skill',       glyph: '✦', description: 'Run a typed deterministic skill', defaults: { inputMapping: {}, outputMapping: {} } },
      { type: 'agent_swarm', label: 'Agent Swarm', glyph: '⨳', description: 'Parallel agent fan-out over an array', defaults: { capabilityTags: [], maxParallel: 3, mergeStrategy: 'collect_all', inputArrayPath: '', prompt: '', outputKey: 'results' } },
      { type: 'evaluator',   label: 'Evaluator',   glyph: '⚖', description: 'LLM-as-judge — score & route pass/fail', defaults: { targetPath: '', criteria: '', passThreshold: 7, maxRetries: 3 } },
      { type: 'guardrails',  label: 'Guardrails',  glyph: '⛨', description: 'Deterministic policy enforcement', defaults: { rules: [], onViolation: 'block' } },
    ],
  },
  {
    tier: 'knowledge',
    title: 'Knowledge',
    nodes: [
      { type: 'knowledge',         label: 'Knowledge',         glyph: '◇', description: 'Retrieve from a workspace knowledge base', defaults: { queryMode: 'static', topK: 5, retrievalMode: 'contextual' } },
      { type: 'artifact_collect',  label: 'Artifact Collect',  glyph: '⛁', description: 'Package generated artifacts into a versioned collection', defaults: { collectionName: 'Untitled', versioned: true } },
    ],
  },
  {
    tier: 'output',
    title: 'Output & native',
    nodes: [
      { type: 'return_output', label: 'Return Output', glyph: '▣', description: 'Declare the rendered result (html/markdown/table/json/text)', defaults: { renderAs: 'json' } },
      { type: 'artifact_save', label: 'Save Artifact',  glyph: '⭳', description: 'Persist a file artifact to the workspace', defaults: { name: 'output.txt' } },
      { type: 'browser',       label: 'Browser',        glyph: '◐', description: 'Render HTML / screenshot / PDF in real Chromium', defaults: { operation: 'serve_html' } },
    ],
  },
  {
    tier: 'human',
    title: 'Human gates',
    nodes: [
      { type: 'checkpoint', label: 'Checkpoint', glyph: '✓', description: 'Pause for human review', defaults: { approvalMode: 'manual' } },
    ],
  },
];

/** Flat list — preserved for callers that want every type without tier metadata. */
export const PALETTE_NODES: PaletteNodeType[] = SECTIONS.flatMap((section) => section.nodes);

interface ReusableWorkflow {
  id: string;
  // Listing endpoint may return either field depending on schema age.
  title?: string;
  name?: string;
}

export function NodePalette({
  onPick,
  className,
}: {
  onPick?: (type: string, data?: Record<string, unknown>) => void;
  className?: string;
}) {
  const [reusable, setReusable] = useState<ReusableWorkflow[]>([]);
  const [collapsed, setCollapsed] = useState<Record<PaletteTier, boolean>>({
    control: false,
    data: false,
    intel: false,
    knowledge: true,
    output: false,
    human: true,
  });

  useEffect(() => {
    void api<{ workflows: ReusableWorkflow[] }>('/v1/workflows?isReusable=true')
      .then((d) => setReusable(d.workflows ?? []))
      .catch(() => {});
  }, []);

  const toggle = (tier: PaletteTier) => setCollapsed((c) => ({ ...c, [tier]: !c[tier] }));

  const dragPayload = useMemo(() => {
    return (node: PaletteNodeType): string => {
      if (!node.defaults) return node.type;
      return JSON.stringify({ type: node.type, ...node.defaults });
    };
  }, []);

  return (
    <aside
      className={clsx(
        'flex min-h-0 w-48 shrink-0 flex-col gap-1 overflow-x-hidden overflow-y-auto border-r border-line bg-surface p-2 text-xs',
        className,
      )}
    >
      <h3 className="px-1 pb-1 text-[10px] uppercase tracking-wider text-text-muted">Palette</h3>

      {SECTIONS.map((section) => (
        <div key={section.tier} className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => toggle(section.tier)}
            className="mt-1 flex items-center justify-between rounded-sm px-1 py-0.5 text-[10px] uppercase tracking-wider text-text-muted hover:text-text-secondary"
            title={`${collapsed[section.tier] ? 'Expand' : 'Collapse'} ${section.title}`}
          >
            <span>{section.title}</span>
            <span aria-hidden>{collapsed[section.tier] ? '+' : '–'}</span>
          </button>
          {!collapsed[section.tier] && section.nodes.map((n) => (
            <button
              key={n.type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-agentis-node', dragPayload(n));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onPick?.(n.type, n.defaults)}
              className="flex items-start gap-2 rounded-md border border-transparent bg-surface-2 px-2 py-1.5 text-left hover:border-accent/40"
              title={n.description}
            >
              <span className="text-base leading-none">{n.glyph}</span>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-text-primary">{n.label}</span>
                <span className="truncate text-[10px] text-text-muted">{n.description}</span>
              </span>
            </button>
          ))}
        </div>
      ))}

      {reusable.length > 0 && (
        <>
          <div className="my-1 border-t border-line/60" />
          <h3 className="px-1 pb-1 text-[10px] uppercase tracking-wider text-text-muted">Reusable</h3>
          {reusable.map((wf) => {
            const label = wf.title ?? wf.name ?? 'Untitled workflow';
            return (
              <button
                key={wf.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    'application/x-agentis-node',
                    JSON.stringify({ type: 'subflow', workflowId: wf.id, label, inputMapping: {}, outputMapping: {} }),
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => onPick?.('subflow', { workflowId: wf.id, label, inputMapping: {}, outputMapping: {} })}
                className="flex items-start gap-2 rounded-md border border-transparent bg-surface-2 px-2 py-1.5 text-left hover:border-accent/40"
                title={`Subflow: ${label}`}
              >
                <span className="text-base leading-none">▦</span>
                <span className="flex flex-col">
                  <span className="font-medium text-text-primary">{label}</span>
                  <span className="text-[10px] text-text-muted">Subflow</span>
                </span>
              </button>
            );
          })}
        </>
      )}
    </aside>
  );
}
