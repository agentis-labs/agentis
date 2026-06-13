import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../lib/api';
import { playFlip, type FlipSnapshot } from '../shared/flip';
import { useToast } from '../shared/Toast';
import { DEFAULT_RUNTIME_CONFIG, RuntimePicker, runtimeConfigToAdapterConfig, runtimeLabelFor, runtimeModelFor, type AdapterType, type RuntimeConfig } from './RuntimePicker';
import { PlaybookEditor } from './PlaybookEditor';
import { PlaybookLibrary, type PlaybookEntry } from './PlaybookLibrary';

const STEPS = ['Runtime', 'Playbook', 'Deploy'] as const;

export function CommissionFlow({
  open,
  onClose,
  onCommissioned,
  flipFrom,
}: {
  open: boolean;
  onClose: () => void;
  onCommissioned: (agentId: string) => void;
  flipFrom?: FlipSnapshot | null;
}) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [adapterType, setAdapterType] = useState<AdapterType>('openclaw');
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(DEFAULT_RUNTIME_CONFIG);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [glyph, setGlyph] = useState('◈');
  const [playbook, setPlaybook] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [entries, setEntries] = useState<PlaybookEntry[]>([]);
  const [monthlyBudget, setMonthlyBudget] = useState('500');
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void api<{ entries: PlaybookEntry[] }>('/v1/agents/playbook-library').then((res) => setEntries(res.entries)).catch(() => setEntries([]));
  }, [open]);

  if (!open) return null;

  async function commission() {
    if (!name.trim()) {
      toast.error('Agent name required', 'Name the agent before adding it to the fleet.');
      setStep(0);
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ id: string }>('/v1/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          adapterType,
          role: role.trim() || 'Agent',
          avatarGlyph: glyph.trim() || '◈',
          runtimeModel: runtimeModelFor(adapterType, runtimeConfig),
          capabilityTags: tags,
          instructions: playbook,
          monthlyBudgetCents: monthlyBudget.trim() ? Math.round(Number(monthlyBudget) * 100) : null,
          config: runtimeConfigToAdapterConfig(adapterType, runtimeConfig),
        }),
      });
      toast.success(`${name.trim() || 'Agent'} added`, 'The agent is available in the fleet.');
      onCommissioned(res.id);
      window.requestAnimationFrame(() => playFlip(document.getElementById(`agent-card-${res.id}`), flipFrom ?? null));
      onClose();
    } catch (error) {
      toast.error('Could not add agent', (error as { message?: string })?.message ?? 'The agent was not created.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay-strong p-4" role="dialog" aria-modal>
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-lg border border-line bg-surface shadow-card">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">Add agent</h2>
            <div className="mt-2 flex gap-2 text-[11px] text-text-muted">
              {STEPS.map((label, index) => <span key={label} className={index === step ? 'text-accent' : ''}>Step {index + 1} · {label}</span>)}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary" aria-label="Close"><X size={16} /></button>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-5">
          {step === 0 && (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-[80px_1fr_1fr]">
                <Field label="Mark"><input value={glyph} onChange={(e) => setGlyph(e.target.value)} maxLength={8} className={inputCls} /></Field>
                <Field label="Agent name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Field Scout" className={inputCls} /></Field>
                <Field label="Work focus"><input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Monitoring, support, research" className={inputCls} /></Field>
              </div>
              <RuntimePicker
                adapterType={adapterType}
                runtimeConfig={runtimeConfig}
                onAdapterChange={setAdapterType}
                onConfigChange={setRuntimeConfig}
              />
            </div>
          )}
          {step === 1 && (
            <div className="space-y-4">
              <PlaybookLibrary entries={entries} onPick={(entry) => { setPlaybook(entry.markdown.replaceAll('{{name}}', name || 'Agent')); setTags(entry.suggestedTags); setGlyph(entry.glyph); }} />
              <PlaybookEditor value={playbook} onChange={setPlaybook} />
            </div>
          )}
          {step === 2 && (
            <div className="grid gap-4 md:grid-cols-[1fr_280px]">
              <div ref={cardRef} className="rounded-lg border border-line bg-canvas p-4">
                <div className="text-lg">{glyph} {name}</div>
                <div className="mt-1 text-sm text-text-muted">{role} · {runtimeLabelFor(adapterType, runtimeConfig)}</div>
                <p className="mt-4 text-sm text-text-muted">{playbook.split('\n').find(Boolean) ?? 'No playbook content.'}</p>
              </div>
              <Field label="Monthly budget"><input value={monthlyBudget} onChange={(e) => setMonthlyBudget(e.target.value)} className={inputCls} inputMode="decimal" /></Field>
            </div>
          )}
        </main>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3">
          <button type="button" onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))} className="rounded-md border border-line px-3 py-2 text-xs text-text-muted hover:text-text-primary">{step === 0 ? 'Cancel' : 'Back'}</button>
          {step < 2 ? (
            <button type="button" onClick={() => setStep((s) => s + 1)} className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-canvas">Continue</button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void commission()} className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-canvas disabled:opacity-50">{busy ? 'Adding…' : `Add ${name || 'agent'}`}</button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-medium uppercase tracking-wider text-text-muted">{label}</span>{children}</label>;
}

const inputCls = 'w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent';
