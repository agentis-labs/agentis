import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import clsx from 'clsx';
import { slugForNode, type UpstreamNode } from './VariablePicker';
import { generateFieldExpression, type ExpressionDialect, type FieldSource } from './fieldExpression';



export interface FieldPickerProps {
  /** Upstream nodes for the selected node, topologically ordered. */
  upstream: UpstreamNode[];
  /** Which expression form to generate. */
  dialect: ExpressionDialect;
  /** Receives the generated reference to insert into the field. */
  onInsert: (expression: string) => void;
  className?: string;
}

const SPECIAL_STEPS = [
  { value: 'trigger', label: 'Trigger inputs' },
  { value: 'input', label: 'This step’s input' },
] as const;

export function FieldPicker({ upstream, dialect, onInsert, className }: FieldPickerProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState('');
  const [field, setField] = useState('');

  const selectedNode = useMemo(() => upstream.find((n) => n.id === step), [upstream, step]);
  const fieldOptions = useMemo(() => selectedNode?.outputKeys ?? [], [selectedNode]);
  const slugOf = useMemo(() => slugForNode(upstream), [upstream]);

  function sourceFor(): FieldSource | null {
    if (!step) return null;
    if (step === 'trigger') return { origin: 'trigger', path: field || undefined };
    if (step === 'input') return { origin: 'input', path: field || undefined };
    return { origin: 'node', nodeId: slugOf.get(step) ?? step, path: field || undefined };
  }

  function insert() {
    const source = sourceFor();
    if (!source) return;
    onInsert(generateFieldExpression(source, dialect));
    setOpen(false);
    setField('');
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx('inline-flex items-center gap-1 text-[11px] text-accent hover:underline', className)}
      >
        <Plus size={11} /> Use a field from another step
      </button>
    );
  }

  return (
    <div className={clsx('space-y-2 rounded-md border border-line bg-surface-2 p-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={step}
          onChange={(e) => {
            setStep(e.target.value);
            setField('');
          }}
          className="h-7 rounded-input border border-line bg-surface px-1.5 text-[11px] text-text-primary focus:border-accent focus:outline-none"
        >
          <option value="">Pick a step…</option>
          {SPECIAL_STEPS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
          {upstream.length > 0 && (
            <optgroup label="Previous steps">
              {upstream.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title || n.id}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        {fieldOptions.length > 0 ? (
          <select
            value={field}
            onChange={(e) => setField(e.target.value)}
            className="h-7 rounded-input border border-line bg-surface px-1.5 text-[11px] text-text-primary focus:border-accent focus:outline-none"
          >
            <option value="">whole output</option>
            {fieldOptions.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="field (optional)"
            className="h-7 w-32 rounded-input border border-line bg-surface px-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        )}

        <button
          type="button"
          disabled={!step}
          onClick={insert}
          className="inline-flex h-7 items-center gap-1 rounded-btn bg-accent px-2 text-[11px] font-medium text-canvas hover:bg-accent-hover disabled:opacity-40"
        >
          Insert
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-text-muted hover:text-text-primary">
          Cancel
        </button>
      </div>
      {step && (
        <p className="font-mono text-[10px] text-text-muted">
          {generateFieldExpression(sourceFor()!, dialect)}
        </p>
      )}
    </div>
  );
}


