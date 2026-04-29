/**
 * ConfirmDialog — first-class destructive confirmation.
 *
 * Replaces native `window.confirm`. Provides explicit framing for the
 * action being confirmed, an optional severity tone, and supports an
 * imperative `useConfirm()` hook so callers can `await confirm({...})`
 * just like the native API but with our visual language.
 */

import { useCallback, useEffect, useState, createContext, useContext } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ShieldCheck } from 'lucide-react';

export type ConfirmTone = 'danger' | 'warn' | 'neutral';

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const ConfirmCtx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, resolve });
      }),
    [],
  );

  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex items-start gap-3 px-5 pt-5">
              <span
                className={clsx(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  state.tone === 'danger' && 'bg-danger/15 text-danger',
                  state.tone === 'warn' && 'bg-warn/15 text-warn',
                  (state.tone ?? 'neutral') === 'neutral' && 'bg-accent/15 text-accent',
                )}
              >
                {state.tone === 'danger' || state.tone === 'warn' ? (
                  <AlertTriangle size={16} />
                ) : (
                  <ShieldCheck size={16} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium text-text-primary">{state.title}</h3>
                {state.body && (
                  <div className="mt-1 text-xs leading-relaxed text-text-muted">{state.body}</div>
                )}
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
              <button
                type="button"
                onClick={() => close(false)}
                className="rounded-md border border-line px-3 py-1.5 text-xs text-text-muted hover:text-text-primary"
              >
                {state.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => close(true)}
                className={clsx(
                  'rounded-md px-3 py-1.5 text-xs font-medium',
                  state.tone === 'danger' && 'bg-danger text-canvas hover:opacity-90',
                  state.tone === 'warn' && 'bg-warn text-canvas hover:opacity-90',
                  (state.tone ?? 'neutral') === 'neutral' &&
                    'bg-accent text-canvas hover:opacity-90',
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
  // Fallback to native confirm so pages remain usable when rendered
  // outside the provider (page-level unit tests).
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
