import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Boxes, Search } from 'lucide-react';
import { api } from '../../lib/api';
import type { IntegrationManifestLite } from './nodeConfigRegistry';
import { connectorAccent, connectorLogoUrl } from './connectorLogo';
import { nodeKindColor } from './nodeKindMeta';
import { nodeKindIcon } from './nodeKindIcon';

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
      { type: 'wait',     label: 'Wait',     glyph: '◷', description: 'Pause for a duration before resuming', defaults: { delayMs: 60_000 } },
      { type: 'loop',     label: 'Loop',     glyph: '↻', description: 'Iterate over an array with concurrency control', defaults: { maxConcurrency: 1, onIterationError: 'stop_all', outputArrayKey: 'results' } },
      { type: 'pursue',   label: 'Pursue',   glyph: '◎', description: 'Pursue an objective — re-run a cohort, measure progress, reflect when stuck', defaults: { doneWhen: { type: 'judge', targetPath: 'output', criteria: 'The objective is fully met.' }, maxIterations: 8, isolation: 'auto', stopWhenStalled: { after: 2 }, assess: true, maxPivots: 2 } },
      { type: 'parallel', label: 'Parallel', glyph: '⫴', description: 'Fan out to N branches in parallel', defaults: { waitFor: 'all', onBranchError: 'fail_all', mergeStrategy: 'merge_keys' } },
      { type: 'subflow',  label: 'Subflow',  glyph: '▦', description: 'Embed another workflow inline', defaults: { inputMapping: {}, outputMapping: {} } },
      { type: 'stop_error', label: 'Stop & Error', glyph: '⛔', description: 'Terminate the run with a custom error', defaults: { errorMessage: 'Stopped' } },
    ],
  },
  {
    tier: 'data',
    title: 'Data & logic',
    nodes: [
      { type: 'transform',      label: 'Transform',      glyph: '⇄', description: 'Reshape data with a JS expression', defaults: { expression: 'input' } },
      { type: 'filter',         label: 'Filter',         glyph: '◓', description: 'Gate on a boolean expression', defaults: { condition: 'true' } },
      { type: 'integration',    label: 'Integration',    glyph: '⚙', description: 'Call a built-in connector (Slack, Gmail, …)', defaults: { inputs: {} } },
      { type: 'mcp',            label: 'MCP Tool',       glyph: '⌬', description: 'Call a tool on a mounted MCP server (Supabase, Linear, …)', defaults: { toolId: '', arguments: {} } },
      { type: 'http_request',   label: 'HTTP Request',   glyph: '↗', description: 'Raw outbound HTTP call', defaults: { method: 'GET', url: '', headers: {} } },
      { type: 'workflow_store',  label: 'Workflow Store',  glyph: '◧', description: 'Read/write workflow-scoped persistent KV', defaults: { operations: [] } },
      { type: 'workspace_store', label: 'Workspace Store', glyph: '▤', description: 'Read/write workspace-wide KV (shared across all workflows)', defaults: { operations: [] } },
      { type: 'scratchpad',      label: 'Scratchpad',      glyph: '◈', description: 'Run-scoped ephemeral state', defaults: { operation: 'write', key: 'note' } },
      { type: 'code',           label: 'Code',           glyph: '⌗', description: 'Run sandboxed JavaScript (or Python)', defaults: { language: 'javascript', code: 'return input;', inputKeys: [] } },
      { type: 'datetime',       label: 'Date & Time',    glyph: '◷', description: 'Parse, format, diff, or shift dates', defaults: { operation: 'format', outputFormat: 'iso' } },
      { type: 'crypto_util',    label: 'Crypto',         glyph: '⚿', description: 'Hash, HMAC, base64, or UUID', defaults: { operation: 'hash', algorithm: 'sha256' } },
      { type: 'markdown',       label: 'Markdown',       glyph: '⓶', description: 'Convert Markdown ↔ HTML', defaults: { operation: 'to_html' } },
      { type: 'xml_parse',      label: 'XML',            glyph: '‹›', description: 'Convert XML ↔ JSON', defaults: { operation: 'parse' } },
      { type: 'html_extract',   label: 'HTML Extract',   glyph: '⧉', description: 'Extract values from HTML by CSS selector', defaults: { selector: '', extractAs: 'text' } },
      { type: 'json_schema_validate', label: 'Validate Schema', glyph: '✔', description: 'Validate data against a JSON Schema', defaults: { schema: '{\n  "type": "object"\n}', onViolation: 'flag' } },
      { type: 'spreadsheet',    label: 'Spreadsheet',    glyph: '▦', description: 'Parse/build CSV or XLSX rows', defaults: { operation: 'parse', format: 'csv', hasHeaders: true } },
      { type: 'graphql',        label: 'GraphQL',        glyph: '◭', description: 'Run a structured GraphQL query', defaults: { endpoint: '', query: '' } },
    ],
  },
  {
    tier: 'intel',
    title: 'Intelligence',
    nodes: [
      { type: 'agent_task',  label: 'Agent',       glyph: '◎', description: 'A tool-using agent for one focused mission (set Persistent in config for long, delegating, multi-step work)', defaults: { capabilityTags: [], prompt: '', inputKeys: [], outputKeys: [] } },
      { type: 'agent_session', label: 'Agent · persistent', glyph: '◉', description: 'The same agent kept alive across steps — keeps memory, delegates to sub-agents, awaits events, pauses for approval', defaults: { capabilityTags: [], prompt: '', inputKeys: [], outputKeys: [] } },
      { type: 'extension_task',  label: 'Extension',       glyph: '⬡', description: 'Run a typed deterministic extension operation', defaults: { operationName: 'execute', inputMapping: {}, outputMapping: {} } },
      { type: 'agent_swarm', label: 'Agent Swarm', glyph: '⨳', description: 'Parallel agent fan-out over an array', defaults: { capabilityTags: [], maxParallel: 3, mergeStrategy: 'collect_all', inputArrayPath: '', prompt: '', outputKey: 'results' } },
      { type: 'dynamic_swarm', label: 'Dynamic Swarm', glyph: '⧉', description: 'A planner decomposes a goal into tasks, then specialists run them in parallel', defaults: { goal: '', maxTasks: 5, maxParallel: 3, mergeStrategy: 'collect_all', outputKey: 'results', capabilityTags: [] } },
      { type: 'planner',     label: 'Planner',     glyph: '⊞', description: 'Decompose a goal into sequential agent steps and run them in order', defaults: { goal: '', maxNodes: 8, inputKeys: [], outputKeys: [] } },
      { type: 'evaluator',   label: 'Evaluator',   glyph: '⚖', description: 'LLM-as-judge — score & route pass/fail', defaults: { targetPath: '', criteria: '', passThreshold: 7, maxRetries: 3 } },
      { type: 'guardrails',  label: 'Guardrails',  glyph: '⛨', description: 'Deterministic policy enforcement', defaults: { rules: [], onViolation: 'block' } },
    ],
  },
  {
    tier: 'knowledge',
    title: 'Knowledge Base',
    nodes: [
      // The Knowledge Base is RAG over uploaded/ingested documents — distinct from
      // the Brain (the agents' learned memory, which fills automatically from chat
      // and runs, never via a hand-wired node). `knowledge_ingest` is intentionally
      // NOT offered here: writing memory is automatic + agent-tool driven.
      { type: 'knowledge',         label: 'Knowledge search',  glyph: '◇', description: 'Retrieve relevant passages from the workspace Knowledge Base (uploaded docs / RAG)', defaults: { queryMode: 'static', topK: 5, retrievalMode: 'contextual' } },
      { type: 'artifact_collect',  label: 'Artifact Collect',  glyph: '?', description: 'Package generated artifacts into a versioned collection', defaults: { collectionName: 'Untitled', versioned: true } },
    ],
  },
  {
    tier: 'output',
    title: 'Output & native',
    nodes: [
      { type: 'return_output', label: 'Return Output', glyph: '▣', description: 'Declare the rendered result (html/markdown/table/json/text)', defaults: { renderAs: 'json' } },
      { type: 'artifact_save', label: 'Save Artifact',  glyph: '⭳', description: 'Persist a file artifact to the workspace', defaults: { name: 'output.txt' } },
      { type: 'browser',       label: 'Browser',        glyph: '?', description: 'Render HTML / screenshot / PDF in real Chromium', defaults: { operation: 'serve_html' } },
      { type: 'sticky_note',   label: 'Sticky Note',    glyph: '✎', description: 'Canvas annotation — no execution', defaults: { content: 'Note', color: '#fde68a' } },
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

type PaletteTab = 'steps' | 'apps';

export function NodePalette({
  onPick,
  className,
  bare = false,
}: {
  onPick?: (type: string, data?: Record<string, unknown>) => void;
  className?: string;
  /** Drop the standalone aside chrome (width/border) so a parent panel can host it. */
  bare?: boolean;
}) {
  const [reusable, setReusable] = useState<ReusableWorkflow[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationManifestLite[]>([]);
  const [tab, setTab] = useState<PaletteTab>('steps');
  const [query, setQuery] = useState('');

  useEffect(() => {
    void api<{ workflows: ReusableWorkflow[] }>('/v1/workflows?isReusable=true')
      .then((d) => setReusable(d.workflows ?? []))
      .catch(() => {});
    void api<{ integrations: IntegrationManifestLite[] }>('/v1/integrations')
      .then((d) => setIntegrations(d.integrations ?? []))
      .catch(() => {});
  }, []);

  const needle = query.trim().toLowerCase();
  const visibleSections = useMemo(() => {
    if (!needle) return SECTIONS;
    return SECTIONS.map((section) => ({
      ...section,
      nodes: section.nodes.filter((node) =>
        `${node.label} ${node.type} ${node.description}`.toLowerCase().includes(needle),
      ),
    })).filter((section) => section.nodes.length > 0);
  }, [needle]);

  const visibleApps = useMemo(() => {
    const sorted = [...integrations].sort((a, b) => a.name.localeCompare(b.name));
    if (!needle) return sorted;
    return sorted.filter((manifest) =>
      `${manifest.name} ${manifest.service} ${manifest.category ?? ''}`.toLowerCase().includes(needle),
    );
  }, [integrations, needle]);

  const visibleReusable = useMemo(() => {
    if (!needle) return reusable;
    return reusable.filter((wf) => (wf.title ?? wf.name ?? '').toLowerCase().includes(needle));
  }, [reusable, needle]);

  const startDrag = (event: React.DragEvent, payload: Record<string, unknown> | string) => {
    event.dataTransfer.setData(
      'application/x-agentis-node',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
    event.dataTransfer.effectAllowed = 'copy';
  };

  const appDefaults = (manifest: IntegrationManifestLite): Record<string, unknown> => ({
    label: manifest.name,
    integrationId: manifest.service,
    operationId: manifest.operations[0],
    inputs: {},
  });

  return (
    <aside
      className={clsx(
        'flex min-h-0 flex-col text-xs',
        bare ? 'flex-1' : 'w-60 shrink-0 border-r border-line bg-surface',
        className,
      )}
    >
      <div className="shrink-0 space-y-2 p-2 pb-1.5">
        <label className="flex h-8 items-center gap-2 rounded-input border border-line bg-surface-2 px-2.5 focus-within:border-accent/50">
          <Search size={13} className="shrink-0 text-text-muted" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === 'apps' ? 'Search apps…' : 'Search steps…'}
            className="w-full bg-transparent text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </label>
        <div className="flex rounded-input border border-line bg-surface-2 p-0.5">
          {(['steps', 'apps'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={clsx(
                'flex-1 rounded-[6px] px-2 py-1 text-[11px] font-medium capitalize transition-colors',
                tab === value ? 'bg-surface-3 text-text-primary shadow-card' : 'text-text-muted hover:text-text-secondary',
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3">
        {tab === 'steps' ? (
          <>
            {visibleSections.map((section) => (
              <div key={section.tier} className="mt-2 first:mt-1">
                <h3 className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                  {section.title}
                </h3>
                <div className="grid grid-cols-3 gap-1.5">
                  {section.nodes.map((n) => {
                    const Icon = nodeKindIcon(n.type);
                    const color = nodeKindColor(n.type);
                    return (
                      <button
                        key={n.type}
                        draggable
                        onDragStart={(e) => startDrag(e, n.defaults ? { type: n.type, ...n.defaults } : n.type)}
                        onClick={() => onPick?.(n.type, n.defaults)}
                        className="group flex flex-col items-center gap-1 rounded-xl border border-transparent bg-surface-2 px-1 py-2 text-center transition-colors hover:border-accent/40 hover:bg-surface-3"
                        title={`${n.label} — ${n.description}`}
                      >
                        <span
                          className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px]"
                          style={{ backgroundColor: `${color}1c`, color, boxShadow: `inset 0 0 0 1px ${color}2e` }}
                          aria-hidden
                        >
                          <Icon size={15} strokeWidth={1.9} />
                        </span>
                        <span className="w-full truncate px-0.5 text-[9.5px] leading-tight text-text-secondary group-hover:text-text-primary">
                          {n.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {visibleSections.length === 0 && (
              <p className="px-1 py-6 text-center text-[11px] text-text-muted">No steps match “{query}?.</p>
            )}

            {visibleReusable.length > 0 && (
              <div className="mt-3 border-t border-line/60 pt-2">
                <h3 className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                  Reusable workflows
                </h3>
                <div className="flex flex-col gap-1">
                  {visibleReusable.map((wf) => {
                    const label = wf.title ?? wf.name ?? 'Untitled workflow';
                    const payload = { type: 'subflow', workflowId: wf.id, label, inputMapping: {}, outputMapping: {} };
                    return (
                      <button
                        key={wf.id}
                        draggable
                        onDragStart={(e) => startDrag(e, payload)}
                        onClick={() => onPick?.('subflow', { workflowId: wf.id, label, inputMapping: {}, outputMapping: {} })}
                        className="flex items-center gap-2 rounded-lg border border-transparent bg-surface-2 px-2 py-1.5 text-left transition-colors hover:border-accent/40"
                        title={`Subflow: ${label}`}
                      >
                        <Boxes size={13} className="shrink-0 text-text-muted" aria-hidden />
                        <span className="min-w-0 truncate text-[11px] font-medium text-text-primary">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {visibleApps.map((manifest) => (
                <button
                  key={manifest.id ?? manifest.service}
                  draggable
                  onDragStart={(e) => startDrag(e, { type: 'integration', ...appDefaults(manifest) })}
                  onClick={() => onPick?.('integration', appDefaults(manifest))}
                  className="group flex flex-col items-center gap-1 rounded-xl border border-transparent bg-surface-2 px-1 py-2 text-center transition-colors hover:border-accent/40 hover:bg-surface-3"
                  title={`${manifest.name}${manifest.description ? ` — ${manifest.description}` : ''}`}
                >
                  <AppLogo manifest={manifest} />
                  <span className="w-full truncate px-0.5 text-[9.5px] leading-tight text-text-secondary group-hover:text-text-primary">
                    {manifest.name}
                  </span>
                </button>
              ))}
            </div>
            {visibleApps.length === 0 && (
              <p className="px-1 py-6 text-center text-[11px] text-text-muted">
                {integrations.length === 0 ? 'No connected apps yet.' : `No apps match “${query}?.`}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/** Brand logo tile with the colored-initial fallback (no broken-img flash). */
function AppLogo({ manifest }: { manifest: IntegrationManifestLite }) {
  const [failed, setFailed] = useState(false);
  const url = connectorLogoUrl(manifest.icon ?? manifest.service);
  if (!url || failed) {
    const accent = connectorAccent(manifest.service);
    return (
      <span
        className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] text-[13px] font-semibold"
        style={{ backgroundColor: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
        aria-hidden
      >
        {manifest.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-surface-3" aria-hidden>
      <img src={url} alt="" className="h-[18px] w-[18px] object-contain" onError={() => setFailed(true)} />
    </span>
  );
}



