import { useEffect, useState } from 'react';
import { Code2, LayoutTemplate } from 'lucide-react';
import clsx from 'clsx';

export interface InspectorSelection {
  kind: 'node' | 'edge' | null;
  nodeType?: string;
  nodeId?: string;
  data?: Record<string, unknown>;
}

export function ContextInspector({
  selection,
  onClose,
  onSave,
  className,
}: {
  selection: InspectorSelection;
  onClose: () => void;
  onSave?: (data: Record<string, unknown>) => void;
  className?: string;
}) {
  const [jsonMode, setJsonMode] = useState(false);
  const [editData, setEditData] = useState<Record<string, unknown>>(selection.data ?? {});
  const [jsonText, setJsonText] = useState(JSON.stringify(selection.data ?? {}, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    const d = selection.data ?? {};
    setEditData(d);
    setJsonText(JSON.stringify(d, null, 2));
    setJsonError(null);
    setJsonMode(false);
  }, [selection.nodeId, selection.kind]);

  if (!selection.kind) return null;

  function handleJsonChange(val: string) {
    setJsonText(val);
    try {
      setEditData(JSON.parse(val) as Record<string, unknown>);
      setJsonError(null);
    } catch {
      setJsonError('Invalid JSON');
    }
  }

  function handleFieldChange(key: string, value: unknown) {
    const next = { ...editData, [key]: value };
    setEditData(next);
    setJsonText(JSON.stringify(next, null, 2));
  }

  function handleSave() {
    if (jsonError) return;
    onSave?.(editData);
  }

  const hasChanges = JSON.stringify(editData) !== JSON.stringify(selection.data ?? {});

  return (
    <aside className={clsx('flex w-80 shrink-0 flex-col border-l border-line bg-surface text-xs', className)}>
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {selection.kind === 'node' ? (selection.nodeType ?? 'Node') : 'Edge'}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setJsonMode((v) => !v); setJsonError(null); }}
            title={jsonMode ? 'Form view' : 'JSON view'}
            className={clsx(
              'rounded p-1 transition-colors',
              jsonMode ? 'text-accent' : 'text-text-muted hover:text-text-primary',
            )}
          >
            {jsonMode ? <LayoutTemplate size={12} /> : <Code2 size={12} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="rounded p-1 text-text-muted hover:text-accent"
          >
            ×
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-3">
        {selection.nodeId && (
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Node ID</div>
            <div className="mt-0.5 font-mono text-[11px] text-text-secondary">{selection.nodeId}</div>
          </div>
        )}

        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">Configuration</div>

        {jsonMode ? (
          <div>
            <textarea
              value={jsonText}
              onChange={(e) => handleJsonChange(e.target.value)}
              rows={14}
              spellCheck={false}
              className={clsx(
                'w-full resize-none rounded-md border bg-surface-2 p-2 font-mono text-[11px] text-text-primary focus:outline-none focus:border-accent',
                jsonError ? 'border-danger' : 'border-line',
              )}
            />
            {jsonError && <div className="mt-1 text-[11px] text-danger">{jsonError}</div>}
          </div>
        ) : (
          <div className="space-y-2">
            {Object.keys(editData).length === 0 ? (
              <div className="text-[11px] text-text-muted">No configuration fields.</div>
            ) : (
              Object.entries(editData).map(([key, val]) => (
                <FieldRow
                  key={`${selection.nodeId}-${key}`}
                  label={key}
                  value={val}
                  onChange={(v) => handleFieldChange(key, v)}
                />
              ))
            )}
          </div>
        )}
      </div>

      {onSave && (
        <footer className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || !!jsonError}
            className="inline-flex h-7 items-center rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </footer>
      )}
    </aside>
  );
}

function FieldRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const isBoolean = typeof value === 'boolean';
  const isNumber = typeof value === 'number';
  const isComplex = value !== null && typeof value === 'object';
  const displayLabel = label.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
  const [complexDraft, setComplexDraft] = useState(() =>
    isComplex ? JSON.stringify(value, null, 2) : '',
  );

  return (
    <div>
      <label className="mb-0.5 block text-[10px] font-medium text-text-secondary">{displayLabel}</label>
      {isBoolean ? (
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={value as boolean}
            onChange={(e) => onChange(e.target.checked)}
            className="rounded border-line bg-surface-2 accent-accent"
          />
          <span className="text-[12px] text-text-primary">{(value as boolean) ? 'true' : 'false'}</span>
        </label>
      ) : isNumber ? (
        <input
          type="number"
          value={String(value)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-7 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
        />
      ) : isComplex ? (
        <textarea
          value={complexDraft}
          onChange={(e) => {
            setComplexDraft(e.target.value);
            try {
              onChange(JSON.parse(e.target.value) as unknown);
            } catch {
              /* keep parent unchanged while editing */
            }
          }}
          rows={3}
          spellCheck={false}
          className="w-full resize-none rounded-input border border-line bg-surface-2 p-1.5 font-mono text-[11px] text-text-primary focus:border-accent focus:outline-none"
        />
      ) : (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
        />
      )}
    </div>
  );
}
