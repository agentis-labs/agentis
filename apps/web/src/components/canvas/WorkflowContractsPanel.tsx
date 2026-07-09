import { useState } from 'react';
import clsx from 'clsx';
import { Plus, Trash2, Variable, FileSignature } from 'lucide-react';



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
    <div className="flex flex-col">
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

      <div className="mb-4 rounded-xl border border-accent/20 bg-accent-soft p-4">
        <h3 className="mb-1 text-[13px] font-semibold text-accent">
          {active === 'input' ? 'Input Contracts' : 'Output Contracts'}
        </h3>
        <p className="text-[12px] leading-relaxed text-text-secondary">
          {active === 'input'
            ? 'Define the strict JSON schema for data this workflow requires to start. These fields automatically generate UI forms for manual runs and validate incoming data from external API triggers.'
            : 'Define the strict JSON schema this workflow promises to return upon completion. This ensures connected workflows or external systems receive reliable, well-typed data.'}
        </p>
      </div>

      <div>
        {(current?.fields ?? []).length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line bg-canvas/50 py-8 text-center">
            <div className="mb-3 rounded-full border border-line bg-surface-2 p-2.5 text-text-muted shadow-sm">
              {active === 'input' ? <Variable size={18} /> : <FileSignature size={18} />}
            </div>
            <div className="text-[13px] font-medium text-text-primary">
              No {active === 'input' ? 'input' : 'output'} fields defined
            </div>
            <p className="mt-1 text-[12px] text-text-muted max-w-[250px]">
              {active === 'input' ? 'Add strongly-typed fields that callers must provide.' : 'Add strongly-typed fields that this workflow must produce.'}
            </p>
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



