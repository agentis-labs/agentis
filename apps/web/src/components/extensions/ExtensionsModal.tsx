/**
 * ExtensionsModal — quick-access modal wrapper around {@link ExtensionsPanel}.
 *
 * Extensions are how you run REAL deterministic code on compute instead of
 * spending LLM tokens: scrapers, parsers, signers, sync jobs, math, custom
 * protocols, and listener sources. They're a workflow-building block, not a
 * top-level destination, so this modal is the surface everywhere they're
 * managed — launched from the Apps hub header and each workflow canvas toolbar,
 * both backed by the same `ExtensionsPanel` so list/create/edit/delete behavior
 * is identical.
 */

import { useEffect, useState } from 'react';
import { Code2 } from 'lucide-react';
import { ExtensionsPanel } from './ExtensionsPanel';

export function ExtensionsModal({ onClose }: { onClose: () => void }) {
  const [dialogActive, setDialogActive] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dialogActive) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, dialogActive]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm" onClick={() => { if (!dialogActive) onClose(); }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[88vh] max-h-[900px] w-[min(940px,95vw)] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-modal"
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
            <Code2 size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-text-primary">Extensions</div>
            <div className="mt-0.5 text-[12px] text-text-muted">
              Run <span className="text-text-secondary">real deterministic code on compute</span> instead of spending LLM tokens.
              Build almost anything — and call it from any workflow node.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">✕</button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <ExtensionsPanel onActiveDialogChange={setDialogActive} />
        </div>
      </div>
    </div>
  );
}
