/**
 * WorkflowCreateDialog — dual-path workflow creation.
 *
 * Three options:
 *   1. Describe in words (prompt-first, opens canvas with chat input)
 *   2. Start from scratch (empty canvas)
 *   3. Use a template (template browser)
 */

import { useEffect, useState } from 'react';
import { X, Sparkles, FileCode, ArrowRight } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface WorkflowCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
}

interface Template { id: string; name: string; description?: string; }

export function WorkflowCreateDialog({ open, onClose, onCreated }: WorkflowCreateDialogProps) {
  const toast = useToast();
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPrompt(''); setShowTemplates(false);
    void api<{ templates: Template[] }>('/v1/workflows/templates').then((d) => setTemplates(d.templates ?? [])).catch(() => setTemplates([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function createBlank(initialPrompt?: string) {
    setCreating(true);
    try {
      const data = await api<{ workflow: { id: string } }>('/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: initialPrompt ? 'New workflow' : 'Untitled workflow',
          initialPrompt: initialPrompt || undefined,
        }),
      });
      onCreated(data.workflow.id);
    } catch (e) { toast.error('Failed to create workflow', String(e)); }
    finally { setCreating(false); }
  }

  async function createFromTemplate(t: Template) {
    setCreating(true);
    try {
      const data = await api<{ workflow: { id: string } }>('/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({ templateId: t.id, name: t.name }),
      });
      onCreated(data.workflow.id);
    } catch (e) { toast.error('Failed to use template', String(e)); }
    finally { setCreating(false); }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="animate-scale-in w-full max-w-lg rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">{showTemplates ? 'Choose a template' : 'New workflow'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        {!showTemplates ? (
          <div className="space-y-5 px-5 py-5">
            {/* Prompt-first */}
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
                <Sparkles size={12} className="text-accent" /> Describe what it should do
              </label>
              <textarea
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && prompt.trim()) {
                    e.preventDefault();
                    void createBlank(prompt.trim());
                  }
                }}
                placeholder="e.g., Monitor Hacker News and email me a digest at 9am"
                rows={3}
                className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[14px] leading-relaxed text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                disabled={!prompt.trim() || creating}
                onClick={() => void createBlank(prompt.trim())}
                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-btn bg-accent text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {creating ? 'Creating…' : <>Build with agent <ArrowRight size={12} /></>}
              </button>
            </div>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-line" />
              <span className="text-[11px] uppercase tracking-wider text-text-muted">or</span>
              <div className="h-px flex-1 bg-line" />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={creating}
                onClick={() => void createBlank()}
                className="flex flex-col items-start gap-1.5 rounded-card border border-line bg-surface-2 p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-3 disabled:opacity-50"
              >
                <FileCode size={16} className="text-text-secondary" />
                <span className="text-subheading text-text-primary">Start from scratch</span>
                <span className="text-[11px] text-text-muted">Empty canvas</span>
              </button>
              <button
                type="button"
                disabled={creating}
                onClick={() => setShowTemplates(true)}
                className="flex flex-col items-start gap-1.5 rounded-card border border-line bg-surface-2 p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-3 disabled:opacity-50"
              >
                <Sparkles size={16} className="text-text-secondary" />
                <span className="text-subheading text-text-primary">Use a template</span>
                <span className="text-[11px] text-text-muted">{templates.length} available</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto px-5 py-5">
            {templates.length === 0 ? (
              <div className="py-8 text-center">
                <span className="text-[13px] text-text-muted">No templates available.</span>
                <div className="mt-3">
                  <button type="button" onClick={() => setShowTemplates(false)} className="text-[12px] text-accent hover:underline">Back</button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => void createFromTemplate(t)}
                    disabled={creating}
                    className="flex w-full items-start gap-3 rounded-card border border-line bg-surface-2 p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-3 disabled:opacity-50"
                  >
                    <FileCode size={14} className="mt-0.5 shrink-0 text-text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="text-subheading text-text-primary">{t.name}</div>
                      {t.description && <div className="mt-0.5 text-[12px] text-text-muted">{t.description}</div>}
                    </div>
                    <ArrowRight size={12} className="shrink-0 text-text-muted" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {showTemplates && (
          <footer className="flex items-center justify-start border-t border-line bg-surface-2 px-5 py-3">
            <button
              type="button"
              onClick={() => setShowTemplates(false)}
              className="inline-flex h-8 items-center rounded-btn px-2.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
            >← Back</button>
          </footer>
        )}
      </div>
    </div>
  );
}
