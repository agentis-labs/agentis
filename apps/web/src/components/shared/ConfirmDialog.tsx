/**
 * ConfirmDialog — destructive action confirmation with optional type-to-confirm.
 *
 * Replaces native window.confirm. Supports tone (danger/warn/neutral),
 * keyboard shortcuts (Enter=confirm, Escape=cancel), and an optional
 * "type to confirm" pattern for high-impact deletions.
 */

import { useCallback, useEffect, useState, createContext, useContext } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ShieldCheck, Info } from 'lucide-react';

export type ConfirmTone = 'danger' | 'warn' | 'neutral';

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** When set, requires user to type this exact string to enable confirm. */
  typeToConfirm?: string;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const ConfirmCtx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [typed, setTyped] = useState('');

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setState({ ...opts, resolve });
      }),
    [],
  );

  const close = useCallback((ok: boolean) => {
    if (!state) return;
    if (ok && state.typeToConfirm && typed !== state.typeToConfirm) return; // gate
    state.resolve(ok);
    setState(null);
    setTyped('');
  }, [state, typed]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && !state.typeToConfirm) close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  const tone = state?.tone ?? 'neutral';
  const Icon = tone === 'danger' || tone === 'warn' ? AlertTriangle : tone === 'neutral' ? Info : ShieldCheck;
  const canConfirm = !state?.typeToConfirm || typed === state.typeToConfirm;

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true">
          <div className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal">
            <div className="flex items-start gap-3 px-5 pt-5">
              <span
                className={clsx(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                  tone === 'danger' && 'bg-danger-soft text-danger',
                  tone === 'warn'   && 'bg-warn-soft text-warn',
                  tone === 'neutral' && 'bg-accent-soft text-accent',
                )}
              >
                <Icon size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-subheading text-text-primary break-words">{state.title}</h3>
                {state.body && (
                  <div className="mt-1.5 text-[13px] leading-relaxed text-text-secondary break-words">{state.body}</div>
                )}
                {state.typeToConfirm && (
                  <div className="mt-3 space-y-1.5">
                    <label className="text-[12px] text-text-muted">
                      Type <span className="font-mono text-text-primary">{state.typeToConfirm}</span> to confirm:
                    </label>
                    <input
                      autoFocus
                      type="text"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      className="h-9 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                      placeholder={state.typeToConfirm}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
              <button
                type="button"
                onClick={() => close(false)}
                className="inline-flex h-9 items-center justify-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                {state.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                autoFocus={!state.typeToConfirm}
                disabled={!canConfirm}
                onClick={() => close(true)}
                className={clsx(
                  'inline-flex h-9 items-center justify-center rounded-btn px-3 text-[13px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40',
                  tone === 'danger' && 'bg-danger text-white hover:bg-danger/90',
                  tone === 'warn'   && 'bg-warn text-canvas hover:opacity-90',
                  tone === 'neutral' && 'bg-accent text-canvas hover:bg-accent-hover',
                )}
              >
                {state.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  return (
    ctx ??
    ((opts: ConfirmOptions) =>
      Promise.resolve(
        typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(opts.title)
          : true,
      ))
  );
}



