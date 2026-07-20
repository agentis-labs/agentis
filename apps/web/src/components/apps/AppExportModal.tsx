/**
 * AppExportModal — see exactly what leaves with an App, and choose.
 *
 * Exporting used to be a single button that silently produced a skeleton: the
 * App's agents, their memory, its knowledge and its data were all left behind,
 * and nothing said so. This shows the App's full dependency closure BEFORE the
 * download — every workflow, agent, knowledge base, extension and collection,
 * plus what the receiver will have to reconnect themselves.
 *
 * Unticking a required dependency is allowed, with a warning. The operator owns
 * this workspace; a gate that cannot be passed is worse than an informed choice.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, Download, LoaderCircle, X } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';

type ClosureKind = 'workflow' | 'agent' | 'knowledgeBase' | 'extension' | 'collection' | 'credential' | 'connection' | 'connector';

interface ClosureItem {
  kind: ClosureKind;
  id: string;
  label: string;
  required: boolean;
  ownedByApp: boolean;
  reason: string;
  transportable: boolean;
}

interface AppClosure {
  items: ClosureItem[];
  warnings: string[];
}

/** Display order + copy. Grouped so the operator reads it as a story, not a list. */
const SECTIONS: Array<{ kind: ClosureKind; title: string; blurb: string }> = [
  { kind: 'workflow', title: 'Workflows', blurb: 'Including sub-workflows called by steps' },
  { kind: 'agent', title: 'Agents', blurb: 'Their instructions, config and learned memory' },
  { kind: 'knowledgeBase', title: 'Knowledge', blurb: 'Documents re-indexed on the receiving side' },
  { kind: 'collection', title: 'Data', blurb: 'Collection schemas, and rows in a Full export' },
  { kind: 'extension', title: 'Extensions', blurb: 'Custom runtimes the steps invoke' },
];

/** Cannot be copied — the receiver must supply these. Shown, never selectable. */
const REQUIREMENT_KINDS: ClosureKind[] = ['credential', 'connection', 'connector'];

export function AppExportModal({
  appId,
  appName,
  appSlug,
  onClose,
}: {
  appId: string;
  appName: string;
  appSlug: string;
  onClose: () => void;
}) {
  const [closure, setClosure] = useState<AppClosure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(true);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api<{ data: AppClosure }>(`/v1/apps/${appId}/export/preview`)
      .then((r) => { if (!cancelled) setClosure(r.data); })
      .catch((e) => { if (!cancelled) setError(apiErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [appId]);

  const key = (item: ClosureItem) => `${item.kind}:${item.id}`;
  const toggle = useCallback((item: ClosureItem) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      const k = key(item);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  const requirements = useMemo(
    () => (closure?.items ?? []).filter((i) => REQUIREMENT_KINDS.includes(i.kind)),
    [closure],
  );
  /** Required things the operator chose to drop — worth saying out loud. */
  const droppedRequired = useMemo(
    () => (closure?.items ?? []).filter((i) => i.required && i.transportable && excluded.has(key(i))),
    [closure, excluded],
  );

  const doExport = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ fidelity: full ? 'full' : 'shareable' });
      if (excluded.size > 0) params.set('exclude', [...excluded].join(','));
      const envelope = await api<{ data: unknown }>(`/v1/apps/${appId}/export?${params}`).then((r) => r.data);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${appSlug || 'app'}.agentisapp`;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [appId, appSlug, excluded, full, onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-canvas/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[88vh] w-[min(620px,94vw)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-modal" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-line px-5 py-4">
          <Boxes size={16} className="text-accent" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Export app</div>
            <div className="truncate text-[14px] font-semibold text-text-primary">{appName}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {error && (
            <div className="mb-3 flex items-start gap-2 rounded-card border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {!closure && !error ? (
            <div className="flex items-center gap-2 py-8 text-[12px] text-text-muted">
              <LoaderCircle size={14} className="animate-spin" /> Working out what this App needs…
            </div>
          ) : null}

          {closure && (
            <div className="space-y-4">
              <label className="flex cursor-pointer items-start gap-2.5 rounded-card border border-accent/30 bg-accent-soft/25 px-3 py-2.5">
                <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-line accent-accent" />
                <span className="text-[12px] leading-relaxed text-text-secondary">
                  <span className="font-semibold text-text-primary">Include memory &amp; data</span> — agents arrive with what they
                  learned, plus the App Brain, knowledge and collection rows. Untick to export structure only.
                  <span className="mt-0.5 block text-[11px] text-text-muted">Credentials and tokens never travel, either way.</span>
                </span>
              </label>

              {SECTIONS.map((section) => {
                const items = closure.items.filter((i) => i.kind === section.kind);
                if (items.length === 0) return null;
                return (
                  <div key={section.kind}>
                    <div className="mb-1.5 flex items-baseline gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{section.title}</span>
                      <span className="text-[11px] text-text-muted">{section.blurb}</span>
                    </div>
                    <div className="space-y-1">
                      {items.map((item) => {
                        const off = excluded.has(key(item));
                        return (
                          <label key={key(item)} className="flex cursor-pointer items-start gap-2.5 rounded-btn border border-line bg-canvas/45 px-3 py-2">
                            <input type="checkbox" checked={!off} onChange={() => toggle(item)} className="mt-0.5 h-3.5 w-3.5 rounded border-line accent-accent" />
                            <span className="min-w-0 flex-1">
                              <span className={`block truncate text-[12.5px] ${off ? 'text-text-muted line-through' : 'text-text-primary'}`}>{item.label}</span>
                              <span className="block text-[11px] text-text-muted">{item.reason}</span>
                              {off && item.required && (
                                <span className="mt-0.5 block text-[11px] text-warn">This App will not run without it.</span>
                              )}
                            </span>
                            {!item.ownedByApp && (
                              <span className="shrink-0 rounded-pill border border-line px-1.5 py-0.5 text-[10px] text-text-muted">shared</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {requirements.length > 0 && (
                <div className="rounded-card border border-warn/30 bg-warn-soft/30 px-3 py-2.5">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-warn">The receiver must set these up</div>
                  <div className="flex flex-wrap gap-1.5">
                    {requirements.map((r) => (
                      <span key={key(r)} title={r.reason} className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">{r.label}</span>
                    ))}
                  </div>
                </div>
              )}

              {closure.warnings.map((w) => (
                <div key={w} className="flex items-start gap-2 rounded-card border border-line bg-canvas/45 px-3 py-2 text-[11.5px] text-text-muted">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" /> {w}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          {droppedRequired.length > 0 && (
            <span className="mr-auto text-[11px] text-warn">
              {droppedRequired.length} required item{droppedRequired.length === 1 ? '' : 's'} excluded — the App may not run.
            </span>
          )}
          <button type="button" onClick={onClose} className="ml-auto h-9 rounded-btn border border-line px-3 text-[12px] text-text-secondary hover:bg-surface-2">Cancel</button>
          <button
            type="button"
            onClick={() => void doExport()}
            disabled={busy || !closure}
            className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-4 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-45"
          >
            {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />} Export .agentisapp
          </button>
        </div>
      </div>
    </div>
  );
}
