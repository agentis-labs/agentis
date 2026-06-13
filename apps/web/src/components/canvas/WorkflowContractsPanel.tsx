import { useState } from 'react';
import clsx from 'clsx';
import { Plus, Trash2 } from 'lucide-react';

/**
 * WorkflowContractsPanel — edit the workflow's input + output contracts.
 *
 * A contract declares the shape of trigger inputs the workflow accepts AND the
 * shape of outputs an Output-marked node must produce. The engine validates
 * COMPLETED runs against `outputContract` and flips the run status to
 * COMPLETED_WITH_CONTRACT_VIOLATION when the shape doesn't match — operators
 * see the violation on the canvas instead of silently shipping bad data.
 *
 * Keep the shape stable: Brain runtime evaluation reuses this same
 * WorkflowContract type for workflow outputs.
 */

export interface ContractField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
  required?: boolean;
  description?: string;
}

export interface WorkflowContractValue {
  fields: ContractField[];
}

interface WorkflowContractsPanelProps {
  inputContract?: WorkflowContractValue;
  outputContract?: WorkflowContractValue;
  onChange: (next: { inputContract?: WorkflowContractValue; outputContract?: WorkflowContractValue }) => void;
}

const TYPE_OPTIONS: ContractField['type'][] = ['string', 'number', 'boolean', 'array', 'object', 'any'];

export function WorkflowContractsPanel({ inputContract, outputContract, onChange }: WorkflowContractsPanelProps) {
  const [active, setActive] = useState<'input' | 'output'>('input');
  const current = active === 'input' ? inputContract : outputContract;

  function patchActive(next: WorkflowContractValue | undefined) {
    if (active === 'input') onChange({ inputContract: next, outputContract });
    else onChange({ inputContract, outputContract: next });
  }

  function addField() {
    patchActive({ fields: [...(current?.fields ?? []), { key: '', type: 'string', required: false }] });
  }

  function updateField(idx: number, patch: Partial<ContractField>) {
    const fields = (current?.fields ?? []).map((f, i) => (i === idx ? { ...f, ...patch } : f));
    patchActive({ fields });
  }

  function removeField(idx: number) {
    const fields = (current?.fields ?? []).filter((_, i) => i !== idx);
    patchActive(fields.length > 0 ? { fields } : undefined);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex gap-1 rounded-md border border-line bg-surface-2 p-1">
        <button
          type="button"
          onClick={() => setActive('input')}
          className={clsx(
            'flex-1 rounded px-2 py-1 text-[11px] transition-colors',
            active === 'input' ? 'bg-canvas text-text-primary' : 'text-text-muted hover:text-text-primary',
          )}
        >
          Input
        </button>
        <button
          type="button"
          onClick={() => setActive('output')}
          className={clsx(
            'flex-1 rounded px-2 py-1 text-[11px] transition-colors',
            active === 'output' ? 'bg-canvas text-text-primary' : 'text-text-muted hover:text-text-primary',
          )}
        >
          Output
        </button>
      </div>

      <p className="mb-2 text-[10px] leading-relaxed text-text-muted">
        {active === 'input'
          ? 'Declare the shape of trigger inputs callers must provide. Used to validate webhook bodies, manual-run forms, and parent-workflow handoffs.'
          : 'Declare the shape of final outputs nodes marked "Use as workflow output" must produce. Runs that complete with a mismatched output land in COMPLETED_WITH_CONTRACT_VIOLATION.'}
      </p>

      <div className="min-h-0 flex-1 overflow-auto">
        {(current?.fields ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-3 text-center text-[11px] text-text-muted">
            No fields declared. {active === 'input' ? 'Add fields callers must supply.' : 'Add fields the workflow must produce.'}
          </div>
        ) : (
          <div className="space-y-2">
            {(current?.fields ?? []).map((field, idx) => (
              <div key={idx} className="rounded-md border border-line bg-surface-2 p-2">
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    className="h-7 flex-1 rounded-input border border-line bg-canvas px-2 text-[11px] text-text-primary focus:border-accent focus:outline-none"
                    placeholder="field_name"
                    value={field.key}
                    onChange={(e) => updateField(idx, { key: e.target.value })}
                  />
                  <select
                    className="h-7 rounded-input border border-line bg-canvas px-1 text-[11px] text-text-primary focus:border-accent focus:outline-none"
                    value={field.type}
                    onChange={(e) => updateField(idx, { type: e.target.value as ContractField['type'] })}
                  >
                    {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeField(idx)}
                    className="rounded p-1 text-text-muted hover:bg-danger/10 hover:text-danger"
                    aria-label="Remove field"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <label className="inline-flex items-center gap-1 text-[10px] text-text-muted">
                    <input
                      type="checkbox"
                      checked={field.required ?? false}
                      onChange={(e) => updateField(idx, { required: e.target.checked })}
                      className="rounded border-line bg-canvas accent-accent"
                    />
                    required
                  </label>
                  <input
                    type="text"
                    className="h-6 flex-1 rounded-input border border-line bg-canvas px-2 text-[10px] text-text-secondary placeholder:text-text-muted focus:border-accent focus:outline-none"
                    placeholder="description (optional)"
                    value={field.description ?? ''}
                    onChange={(e) => updateField(idx, { description: e.target.value || undefined })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={addField}
        className="mt-2 inline-flex items-center justify-center gap-1 rounded-md border border-dashed border-line bg-surface px-2 py-1.5 text-[11px] text-text-secondary hover:border-accent hover:text-accent"
      >
        <Plus size={11} /> Add field
      </button>
    </div>
  );
}
