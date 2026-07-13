/**
 * ListenerInspector — structured editor for a persistent_listener trigger
 * (EXTENSIONS-AND-LISTENER-10X §4.2). Replaces the old "plain text" placeholder
 * with a three-layer wizard: SOURCE → PREDICATE → FIRE POLICY.
 *
 * The full ListenerConfig is stored on the trigger node's `data.listenerConfig`
 * so it round-trips with the graph; when the trigger is registered the same
 * object becomes the triggers.config the ListenerRuntime reads.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hammer } from 'lucide-react';
import { api } from '../../lib/api';
import { ExtensionStudioModal } from '../extensions/ExtensionStudioModal';

type SourceKind =
  | 'interval' | 'websocket' | 'sse' | 'http_poll' | 'message_queue' | 'db_notify'
  | 'file_watch' | 'extension' | 'agent_event' | 'workflow_event';

interface ListenerConfig {
  source: { kind: SourceKind } & Record<string, unknown>;
  predicate?: { kind: string } & Record<string, unknown>;
  firePolicy?: { mode: string } & Record<string, unknown>;
  payloadTransform?: string;
}

interface ListenerSourceOption {
  id: string;
  slug: string;
  name: string;
  operations: Array<{
    name: string;
    description?: string;
    cursorSupported?: boolean;
    inputSchema?: Record<string, unknown>;
  }>;
}

const SOURCE_META: Array<{ kind: SourceKind; label: string; blurb: string; disabled?: boolean }> = [
  { kind: 'interval', label: 'Interval (timer)', blurb: 'Run the workflow on a fixed clock — e.g. every 10 seconds. The way to say "run every N seconds".' },
  { kind: 'extension', label: 'Extension source', blurb: 'Run a custom sandboxed Extension operation as the source. Any logic.' },
  { kind: 'http_poll', label: 'HTTP Poll', blurb: 'Poll an HTTP endpoint on an interval, with a durable cursor.' },
  { kind: 'websocket', label: 'WebSocket', blurb: 'Stay connected to a WebSocket URL and receive JSON messages.' },
  { kind: 'sse', label: 'Server-Sent Events', blurb: 'Subscribe to an SSE stream.' },
  { kind: 'agent_event', label: 'Agent event', blurb: 'Fire when another agent emits an event on the bus.' },
  { kind: 'workflow_event', label: 'Workflow event', blurb: 'Fire when another workflow run finishes.' },
  { kind: 'file_watch', label: 'File watch', blurb: 'Watch a path for add/change/unlink.' },
  { kind: 'message_queue', label: 'Message queue', blurb: 'AMQP / Kafka / Redis / SQS — needs a broker add-on.', disabled: true },
  { kind: 'db_notify', label: 'Database notify', blurb: 'Postgres LISTEN/NOTIFY — needs a pg add-on.', disabled: true },
];

/** Seed a valid source shape when a kind is first picked (so it needs no extra edits to activate). */
const SOURCE_DEFAULTS: Partial<Record<SourceKind, { kind: SourceKind } & Record<string, unknown>>> = {
  interval: { kind: 'interval', intervalMs: 10_000 },
};

const PREDICATE_META = [
  { kind: 'always', label: 'Always', blurb: 'Every event fires.' },
  { kind: 'jsonpath', label: 'JSONPath match', blurb: 'Extract a value and compare it.' },
  { kind: 'jmespath', label: 'JMESPath truthy', blurb: 'Assert an expression is truthy.' },
  { kind: 'extension', label: 'Extension filter', blurb: 'A sandboxed function returns matched/reason.' },
  { kind: 'agent', label: 'Semantic (AI)', blurb: 'An agent reads the event and decides. The moat.' },
];

const POLICY_META = [
  { mode: 'immediate', label: 'Immediate', blurb: '1 event → 1 run.' },
  { mode: 'leading_edge', label: 'Leading edge', blurb: 'Fire once, ignore the burst for a cooldown. Best for agents.' },
  { mode: 'debounce', label: 'Debounce', blurb: 'Fire the latest once the stream goes quiet.' },
  { mode: 'throttle', label: 'Throttle', blurb: 'At most one run per window; newest wins.' },
  { mode: 'batch', label: 'Batch', blurb: 'Collect N events (or wait), then one run with all.' },
];

const inputCls =
  'h-8 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';
const labelCls = 'mb-1 block text-[11px] font-medium text-text-secondary';

export function ListenerInspector({
  data,
  update,
}: {
  data: Record<string, unknown>;
  update: (patch: Record<string, unknown>) => void;
}) {
  const config = (data.listenerConfig as ListenerConfig | undefined) ?? { source: { kind: 'extension' } };
  const triggerId = typeof data.triggerId === 'string' ? data.triggerId : '';
  const [sources, setSources] = useState<ListenerSourceOption[]>([]);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [studioOpen, setStudioOpen] = useState(false);

  const loadSources = useCallback(() => {
    api<{ sources: ListenerSourceOption[] }>('/v1/extensions/listener-sources')
      .then((r) => setSources(r.sources ?? []))
      .catch(() => setSources([]));
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);

  // Persist the structured config to the registered trigger row (debounced) so
  // the ListenerRuntime reads it. Without a triggerId the config still
  // round-trips on the graph node and is applied when the trigger is created.
  const configJson = JSON.stringify(data.listenerConfig ?? null);
  useEffect(() => {
    if (!triggerId || data.listenerConfig == null) return;
    setSaveState('saving');
    const handle = setTimeout(() => {
      api(`/v1/listeners/${triggerId}`, { method: 'PATCH', body: JSON.stringify({ config: data.listenerConfig }) })
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, 800);
    return () => clearTimeout(handle);
  }, [triggerId, configJson]); // eslint-disable-line react-hooks/exhaustive-deps

  const setConfig = (next: ListenerConfig) => update({ listenerConfig: next });
  const patchSource = (p: Record<string, unknown>) => setConfig({ ...config, source: { ...config.source, ...p } });
  const patchPredicate = (p: Record<string, unknown>) =>
    setConfig({ ...config, predicate: { ...(config.predicate ?? { kind: 'always' }), ...p } });
  const patchPolicy = (p: Record<string, unknown>) =>
    setConfig({ ...config, firePolicy: { ...(config.firePolicy ?? { mode: 'immediate' }), ...p } });

  const sourceKind = config.source.kind;
  const predicateKind = config.predicate?.kind ?? 'always';
  const policyMode = config.firePolicy?.mode ?? 'immediate';
  const selectedExt = useMemo(() => sources.find((s) => s.id === config.source.extensionId), [sources, config.source.extensionId]);
  const selectedOperation = useMemo(
    () => selectedExt?.operations.find((operation) => operation.name === config.source.operationName),
    [config.source.operationName, selectedExt],
  );

  return (
    <div className="mb-3 rounded-md border border-line bg-surface-2 p-2">
      {/* Stepper header */}
      <div className="mb-3 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider">
        {(['Source', 'Predicate', 'Fire policy'] as const).map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3;
          return (
            <button
              key={label}
              type="button"
              onClick={() => setStep(n)}
              className={`flex-1 rounded-pill px-2 py-1 ${step === n ? 'bg-accent text-on-accent' : 'bg-canvas text-text-muted hover:text-text-secondary'}`}
            >
              {n}. {label}
            </button>
          );
        })}
      </div>
      {triggerId && (
        <div className="mb-2 text-right text-[10px] text-text-muted">
          {saveState === 'saving' && 'Saving to trigger…'}
          {saveState === 'saved' && '✓ Saved to trigger'}
          {saveState === 'error' && <span className="text-danger">Save failed</span>}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-2">
          <p className="text-[11px] text-text-secondary">Where should Agentis listen?</p>
          <div className="space-y-1">
            {SOURCE_META.map((s) => (
              <label
                key={s.kind}
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 ${
                  sourceKind === s.kind ? 'border-accent bg-canvas' : 'border-line'
                } ${s.disabled ? 'opacity-50' : ''}`}
              >
                <input
                  type="radio"
                  className="mt-0.5"
                  disabled={s.disabled}
                  checked={sourceKind === s.kind}
                  onChange={() => setConfig({ ...config, source: SOURCE_DEFAULTS[s.kind] ?? { kind: s.kind } })}
                />
                <span>
                  <span className="block text-[12px] font-medium text-text-primary">{s.label}</span>
                  <span className="block text-[10px] text-text-muted">{s.blurb}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Per-kind config */}
          <div className="mt-2 border-t border-line/60 pt-2">
            {sourceKind === 'extension' && (
              <>
                <label className={labelCls}>Extension</label>
                <select
                  className={inputCls}
                  value={config.source.extensionId as string ?? ''}
                  onChange={(e) => patchSource({ extensionId: e.target.value, operationName: undefined })}
                >
                  <option value="">— pick a listener-source extension —</option>
                  {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {sources.length === 0 && (
                  <div className="mt-1">
                    <p className="text-[10px] text-warn">No listener-source extensions yet.</p>
                    <button
                      type="button"
                      onClick={() => setStudioOpen(true)}
                      className="mt-1 inline-flex items-center gap-1.5 rounded border border-dashed border-accent/40 bg-accent/5 px-2 py-1 text-[11px] text-accent hover:bg-accent/10"
                    >
                      <Hammer size={11} /> Build a listener-source extension
                    </button>
                  </div>
                )}
                {selectedExt && (
                  <div className="mt-2">
                    <label className={labelCls}>Operation</label>
                    <select
                      className={inputCls}
                      value={config.source.operationName as string ?? ''}
                      onChange={(e) => patchSource({ operationName: e.target.value })}
                    >
                      <option value="">— operation —</option>
                      {selectedExt.operations.map((op) => <option key={op.name} value={op.name}>{op.name}</option>)}
                    </select>
                    {selectedOperation?.description && (
                      <p className="mt-1 text-[10px] leading-4 text-text-muted">{selectedOperation.description}</p>
                    )}
                    <label className={`${labelCls} mt-2`}>Source configuration</label>
                    <JsonConfigEditor
                      value={(config.source.config as Record<string, unknown> | undefined) ?? {}}
                      schema={selectedOperation?.inputSchema}
                      onChange={(value) => patchSource({ config: value })}
                    />
                    <label className={`${labelCls} mt-2`}>Poll interval (ms)</label>
                    <input type="number" className={inputCls} placeholder="60000" value={config.source.pollIntervalMs as number ?? ''} onChange={(e) => patchSource({ pollIntervalMs: Number(e.target.value) || undefined })} />
                  </div>
                )}
              </>
            )}

            {(sourceKind === 'websocket' || sourceKind === 'sse') && (
              <>
                <label className={labelCls}>URL</label>
                <input className={inputCls} placeholder={sourceKind === 'websocket' ? 'wss://…' : 'https://…/stream'} value={config.source.url as string ?? ''} onChange={(e) => patchSource({ url: e.target.value })} />
              </>
            )}

            {sourceKind === 'interval' && (
              <>
                <label className={labelCls}>Run every</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    className={inputCls}
                    placeholder="10"
                    value={config.source.intervalMs != null ? Math.max(1, Math.round((config.source.intervalMs as number) / 1000)) : ''}
                    onChange={(e) => patchSource({ intervalMs: Math.max(1000, (Number(e.target.value) || 10) * 1000) })}
                  />
                  <span className="shrink-0 text-[12px] text-text-secondary">seconds</span>
                </div>
                <p className="mt-1.5 text-[11px] leading-4 text-text-muted">
                  Fires the workflow on a fixed timer (minimum 1s). Each run gets <code className="rounded bg-canvas px-1">{'{{ trigger.tick }}'}</code> and <code className="rounded bg-canvas px-1">{'{{ trigger.firedAt }}'}</code>. Use Immediate fire policy.
                </p>
                <label className="mt-2 flex items-center gap-2 text-[12px] text-text-secondary">
                  <input type="checkbox" checked={Boolean(config.source.fireOnStart)} onChange={(e) => patchSource({ fireOnStart: e.target.checked })} />
                  Also run immediately when activated
                </label>
              </>
            )}

            {sourceKind === 'http_poll' && (
              <>
                <label className={labelCls}>URL</label>
                <input className={inputCls} placeholder="https://api.example.com/items" value={config.source.url as string ?? ''} onChange={(e) => patchSource({ url: e.target.value })} />
                <label className={`${labelCls} mt-2`}>Interval (ms, min 5000)</label>
                <input type="number" className={inputCls} placeholder="60000" value={config.source.intervalMs as number ?? ''} onChange={(e) => patchSource({ intervalMs: Number(e.target.value) || 60000 })} />
                <label className={`${labelCls} mt-2`}>Items path (optional)</label>
                <input className={inputCls} placeholder="$.data.items" value={config.source.itemsPath as string ?? ''} onChange={(e) => patchSource({ itemsPath: e.target.value || undefined })} />
              </>
            )}

            {sourceKind === 'agent_event' && (
              <>
                <label className={labelCls}>Agent ID</label>
                <input className={inputCls} value={config.source.agentId as string ?? ''} onChange={(e) => patchSource({ agentId: e.target.value })} />
                <label className={`${labelCls} mt-2`}>Event types (comma-separated)</label>
                <input className={inputCls} placeholder="agent.task.completed" value={((config.source.eventTypes as string[]) ?? []).join(', ')} onChange={(e) => patchSource({ eventTypes: csv(e.target.value) })} />
              </>
            )}

            {sourceKind === 'workflow_event' && (
              <>
                <label className={labelCls}>Workflow ID</label>
                <input className={inputCls} value={config.source.workflowId as string ?? ''} onChange={(e) => patchSource({ workflowId: e.target.value })} />
                <label className={`${labelCls} mt-2`}>On status</label>
                <input className={inputCls} placeholder="COMPLETED, FAILED" value={((config.source.onStatus as string[]) ?? []).join(', ')} onChange={(e) => patchSource({ onStatus: csv(e.target.value) })} />
              </>
            )}

            {sourceKind === 'file_watch' && (
              <>
                <label className={labelCls}>Path</label>
                <input className={inputCls} placeholder="/data/incoming" value={config.source.path as string ?? ''} onChange={(e) => patchSource({ path: e.target.value })} />
                <label className={`${labelCls} mt-2`}>Events</label>
                <input className={inputCls} placeholder="add, change, unlink" value={((config.source.events as string[]) ?? []).join(', ')} onChange={(e) => patchSource({ events: csv(e.target.value) })} />
              </>
            )}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-2">
          <p className="text-[11px] text-text-secondary">Should an event fire the workflow?</p>
          <select className={inputCls} value={predicateKind} onChange={(e) => setConfig({ ...config, predicate: { kind: e.target.value } })}>
            {PREDICATE_META.map((p) => <option key={p.kind} value={p.kind}>{p.label}</option>)}
          </select>
          <p className="text-[10px] text-text-muted">{PREDICATE_META.find((p) => p.kind === predicateKind)?.blurb}</p>

          {predicateKind === 'jsonpath' && (
            <div className="mt-2 space-y-2">
              <input className={inputCls} placeholder="expression e.g. $.event.type" value={config.predicate?.expression as string ?? ''} onChange={(e) => patchPredicate({ expression: e.target.value })} />
              <select className={inputCls} value={config.predicate?.operator as string ?? 'eq'} onChange={(e) => patchPredicate({ operator: e.target.value })}>
                {['eq', 'neq', 'contains', 'gt', 'lt', 'exists', 'not_exists'].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input className={inputCls} placeholder="expected value" value={config.predicate?.expected as string ?? ''} onChange={(e) => patchPredicate({ expected: e.target.value })} />
            </div>
          )}
          {predicateKind === 'jmespath' && (
            <input className={`${inputCls} mt-2`} placeholder="events[?type == 'push']" value={config.predicate?.expression as string ?? ''} onChange={(e) => patchPredicate({ expression: e.target.value })} />
          )}
          {predicateKind === 'agent' && (
            <div className="mt-2 space-y-2">
              <input className={inputCls} placeholder="Agent ID" value={config.predicate?.agentId as string ?? ''} onChange={(e) => patchPredicate({ agentId: e.target.value })} />
              <textarea className="w-full resize-none rounded-input border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-text-primary" rows={3} placeholder="Does this event represent a meaningful change worth processing? Reply yes or no." value={config.predicate?.prompt as string ?? ''} onChange={(e) => patchPredicate({ prompt: e.target.value })} />
            </div>
          )}
          {predicateKind === 'extension' && (
            <div className="mt-2 space-y-2">
              <select className={inputCls} value={config.predicate?.extensionId as string ?? ''} onChange={(e) => patchPredicate({ extensionId: e.target.value })}>
                <option value="">— extension —</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <input className={inputCls} placeholder="operation name" value={config.predicate?.operationName as string ?? ''} onChange={(e) => patchPredicate({ operationName: e.target.value })} />
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-2">
          <p className="text-[11px] text-text-secondary">How do matching events become runs?</p>
          <select className={inputCls} value={policyMode} onChange={(e) => setConfig({ ...config, firePolicy: { mode: e.target.value } })}>
            {POLICY_META.map((p) => <option key={p.mode} value={p.mode}>{p.label}</option>)}
          </select>
          <p className="text-[10px] text-text-muted">{POLICY_META.find((p) => p.mode === policyMode)?.blurb}</p>

          {policyMode === 'leading_edge' && (
            <input type="number" className={`${inputCls} mt-2`} placeholder="cooldown ms (e.g. 300000)" value={config.firePolicy?.cooldownMs as number ?? ''} onChange={(e) => patchPolicy({ cooldownMs: Number(e.target.value) || 0 })} />
          )}
          {(policyMode === 'debounce' || policyMode === 'throttle') && (
            <input type="number" className={`${inputCls} mt-2`} placeholder="window ms" value={config.firePolicy?.windowMs as number ?? ''} onChange={(e) => patchPolicy({ windowMs: Number(e.target.value) || 0 })} />
          )}
          {policyMode === 'batch' && (
            <div className="mt-2 space-y-2">
              <input type="number" className={inputCls} placeholder="batch size" value={config.firePolicy?.size as number ?? ''} onChange={(e) => patchPolicy({ size: Number(e.target.value) || 0 })} />
              <input type="number" className={inputCls} placeholder="max wait ms" value={config.firePolicy?.maxWaitMs as number ?? ''} onChange={(e) => patchPolicy({ maxWaitMs: Number(e.target.value) || 0 })} />
              <input className={inputCls} placeholder="coalesce key (optional, e.g. $.id)" value={config.firePolicy?.coalesceKey as string ?? ''} onChange={(e) => patchPolicy({ coalesceKey: e.target.value || undefined })} />
            </div>
          )}
        </div>
      )}

      {studioOpen && (
        <ExtensionStudioModal
          onClose={() => setStudioOpen(false)}
          onCreated={(ext) => {
            setStudioOpen(false);
            loadSources();
            patchSource({ extensionId: ext.id });
          }}
        />
      )}
    </div>
  );
}

function csv(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function JsonConfigEditor({
  value,
  schema,
  onChange,
}: {
  value: Record<string, unknown>;
  schema?: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const valueJson = JSON.stringify(value);
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setError(null);
  }, [valueJson]);

  const properties = schema && typeof schema.properties === 'object' && schema.properties
    ? Object.keys(schema.properties as Record<string, unknown>)
    : [];

  return (
    <div>
      {properties.length > 0 && (
        <p className="mb-1 text-[10px] text-text-muted">
          Expected fields: <span className="font-mono text-text-secondary">{properties.join(', ')}</span>
        </p>
      )}
      <textarea
        rows={5}
        className="w-full resize-y rounded-input border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] leading-4 text-text-primary focus:border-accent focus:outline-none"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              setError('Configuration must be a JSON object.');
              return;
            }
            setError(null);
            onChange(parsed as Record<string, unknown>);
          } catch {
            setError('Enter valid JSON. Your last valid configuration is still saved.');
          }
        }}
        spellCheck={false}
        aria-invalid={Boolean(error)}
      />
      {error && <p className="mt-1 text-[10px] text-danger">{error}</p>}
    </div>
  );
}



