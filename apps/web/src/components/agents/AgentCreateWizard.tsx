/**
 * AgentCreateWizard — guided multi-step agent creation.
 *
 * Two steps:
 *   1. Identity   — image upload (optional) or initials, name, description, space
 *   2. Connection — adapter type cards, model field
 *
 * Inspired by the design references in docs/design-inspirations.
 * Replaces the previous terrible modal. Goal: 30 seconds to ship.
 */

import { useEffect, useRef, useState } from 'react';
import { X, Upload, ChevronRight, ChevronLeft } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { DEFAULT_RUNTIME_CONFIG, RuntimePicker, runtimeConfigToAdapterConfig, runtimeModelFor, type AdapterType, type RuntimeConfig } from './RuntimePicker';

interface Space { id: string; name: string; }

interface AgentCreateWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: { id: string; name: string }) => void;
}

function initials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

export function AgentCreateWizard({ open, onClose, onCreated }: AgentCreateWizardProps) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [spaceId, setSpaceId] = useState<string>('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [adapterType, setAdapterType] = useState<AdapterType>('openclaw');
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(DEFAULT_RUNTIME_CONFIG);
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1); setName(''); setDescription(''); setSpaceId(''); setImageDataUrl(null);
    setAdapterType('openclaw'); setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
    void api<{ spaces: Space[] }>('/v1/spaces').then((d) => setSpaces(d.spaces ?? [])).catch(() => setSpaces([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function handleImageChoose() {
    fileRef.current?.click();
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setImageDataUrl((ev.target?.result as string) ?? null);
    reader.readAsDataURL(file);
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const created = await api<{ agent: { id: string; name: string } }>('/v1/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          role: description.trim() || undefined,
          spaceId: spaceId || undefined,
          avatarDataUrl: imageDataUrl || undefined,
          avatarGlyph: initials(name.trim()),
          adapterType,
          runtimeModel: runtimeModelFor(adapterType, runtimeConfig),
          config: runtimeConfigToAdapterConfig(adapterType, runtimeConfig),
        }),
      });
      toast.success('Agent created', name.trim());
      onCreated(created.agent);
    } catch (e) {
      toast.error('Failed to create agent', String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="animate-scale-in w-full max-w-3xl rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h3 className="text-heading text-text-primary">Create an agent</h3>
            <div className="mt-0.5 text-[12px] text-text-muted">Step {step} of 2</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        {/* Step indicator */}
        <div className="flex gap-2 px-5 pt-3">
          <div className={clsx('h-1 flex-1 rounded-full transition-colors', step >= 1 ? 'bg-accent' : 'bg-surface-2')} />
          <div className={clsx('h-1 flex-1 rounded-full transition-colors', step >= 2 ? 'bg-accent' : 'bg-surface-2')} />
        </div>

        {step === 1 && (
          <div className="space-y-4 px-5 py-5">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={handleImageChoose}
                className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-full border-2 border-dashed border-line bg-surface-2 transition-colors hover:border-accent-muted"
                aria-label="Upload avatar"
              >
                {imageDataUrl ? (
                  <img src={imageDataUrl} alt="Avatar" className="h-full w-full object-cover" />
                ) : name.trim() ? (
                  <span className="flex h-full w-full items-center justify-center text-[24px] font-bold text-text-secondary group-hover:text-text-primary">
                    {initials(name)}
                  </span>
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-text-muted group-hover:text-text-primary">
                    <Upload size={20} />
                  </span>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleImageChange}
                className="hidden"
              />
              <div className="flex-1 text-[12px] text-text-muted">
                {imageDataUrl ? (
                  <button
                    type="button"
                    onClick={() => setImageDataUrl(null)}
                    className="text-text-secondary hover:text-text-primary"
                  >Remove image</button>
                ) : (
                  'Upload an image, or initials will be used.'
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-text-secondary">Name</label>
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Thomas"
                className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-text-secondary">Description (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this agent do?"
                rows={3}
                className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-text-secondary">Space (optional)</label>
              <select
                value={spaceId}
                onChange={(e) => setSpaceId(e.target.value)}
                className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="">No space</option>
                {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="px-5 py-5">
            <RuntimePicker
              adapterType={adapterType}
              runtimeConfig={runtimeConfig}
              onAdapterChange={setAdapterType}
              onConfigChange={setRuntimeConfig}
            />
          </div>
        )}

        <footer className="flex items-center justify-between border-t border-line bg-surface-2 px-5 py-3">
          {step === 1 ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center justify-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >Cancel</button>
          ) : (
            <button
              type="button"
              onClick={() => setStep(1)}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            ><ChevronLeft size={12} /> Back</button>
          )}
          {step === 1 ? (
            <button
              type="button"
              disabled={!name.trim()}
              onClick={() => setStep(2)}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >Next <ChevronRight size={12} /></button>
          ) : (
            <button
              type="button"
              disabled={creating}
              onClick={() => void handleCreate()}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >{creating ? 'Creating…' : 'Create agent'}</button>
          )}
        </footer>
      </div>
    </div>
  );
}
